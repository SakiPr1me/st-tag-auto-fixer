import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "tag_auto_fixer";
const defaultTagTree = `scene
content
Danmaku
Advance
	choice
	todo
		R
	remind
Events
	I
summary
extra
NG_scene`;

const defaultSettings = { tagTree: defaultTagTree };
if (!extension_settings[extensionName]) extension_settings[extensionName] = defaultSettings;
const settings = extension_settings[extensionName];
if (!settings.tagTree) settings.tagTree = defaultTagTree;

// ========== 解析标签树（缩进 → 嵌套层级）==========

function parseTagTree() {
	const lines = settings.tagTree.split('\n').filter(l => l.trim());
	const allTags = new Set();
	const siblings = new Set();
	const children = {}; // { parentName: Set of childNames }

	const stack = [];
	for (const line of lines) {
		const rawIndent = line.search(/\S/);
		const name = line.trim();
		allTags.add(name);
		if (rawIndent === 0) siblings.add(name);

		const depth = rawIndent === 0 ? 0 : Math.max(1, Math.round(rawIndent / 2));
		while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop();
		if (stack.length > 0) {
			const parent = stack[stack.length - 1].name;
			if (!children[parent]) children[parent] = new Set();
			children[parent].add(name);
		}
		stack.push({ name, depth });
	}

	return { allTags: [...allTags], siblings, children };
}

// ========== 扫描消息、重建标签树 ==========

function scanAndFill(replaceMode = false) {
	const ctx = getContext();
	if (!ctx?.chat?.length) { toastr?.warning?.('没有聊天消息'); return; }

	let lastMsg = null;
	for (let i = ctx.chat.length - 1; i >= 0; i--) {
		if (!ctx.chat[i].is_user) { lastMsg = ctx.chat[i]; break; }
	}
	if (!lastMsg) { toastr?.warning?.('未找到AI消息'); return; }

	// 清理干扰块
	let clean = lastMsg.mes.replace(/<!DOCTYPE[\s\S]*?<\/html>/gi, '');
	clean = clean.replace(/<xs:schema[\s\S]*?<\/xs:schema>/gi, '');
	clean = clean.replace(/<dream_plot[\s\S]*?<\/dream_plot>/gi, '');
	clean = clean.replace(/<story_plot[\s\S]*?<\/story_plot>/gi, '');
	clean = clean.replace(/<output_format>[\s\S]*?<\/output_format>/gi, '');

	// 拆出所有标签事件（排除自闭合 <.../>）
	const tagRe = /<\/?([a-zA-Z_][a-zA-Z0-9_.-]*)\b[^>]*?(?<!\/)>/g;
	const allTags = [];
	const tagCount = {};

	let m;
	while ((m = tagRe.exec(clean)) !== null) {
		const name = m[1];
		allTags.push({ name, isClose: m[0].startsWith('</'), pos: m.index });
		tagCount[name] = (tagCount[name] || 0) + 1;
	}

	if (!allTags.length) { toastr?.info?.('未检测到任何标签'); return; }

	// 构建完整闭合区间
	const ranges = [];
	const openStack = [];
	for (const t of allTags) {
		if (!t.isClose) {
			openStack.push({ name: t.name, start: t.pos });
		} else {
			// 最近匹配：从后往前找同名开标签
			for (let i = openStack.length - 1; i >= 0; i--) {
				if (openStack[i].name === t.name) {
					ranges.push({ name: t.name, start: openStack[i].start, end: t.pos, children: new Set() });
					openStack.splice(i, 1);
					break;
				}
			}
		}
	}

	// ===== 关键修复：当 ranges 为空时的回退逻辑 =====
	if (!ranges.length) {
		// AI 可能掉了闭合标签。从 allTags 直接检测嵌套关系。
		const uniqueNames = [...new Set(allTags.map(t => t.name))];
		console.log('[TagAutoFixer] 未找到完整闭合对，从孤儿标签推断。检测到的标签:', uniqueNames);

		// 检测 enclosure：即使没有完整闭合对，也能通过栈匹配找到大多数区间
		const enclosureMap = {}; // { name: Set of enclosed tag names }
		for (const name of uniqueNames) enclosureMap[name] = new Set();

		const tempStack = []; // [{ name, startPos }]
		const tempPairs = []; // [{ name, start, end }]

		for (const t of allTags) {
			if (!t.isClose) {
				tempStack.push({ name: t.name, startPos: t.pos });
			} else {
				for (let i = tempStack.length - 1; i >= 0; i--) {
					if (tempStack[i].name === t.name) {
						tempPairs.push({ name: t.name, start: tempStack[i].startPos, end: t.pos });
						// 检查这个区间内包含的其他标签名
						for (const other of allTags) {
							if (other.name !== t.name && other.pos > tempStack[i].startPos && other.pos < t.pos) {
								enclosureMap[t.name].add(other.name);
							}
						}
						tempStack.splice(i, 1);
						break;
					}
				}
			}
		}

		// 孤儿标签（栈中剩余）：它们可能也包含其他标签
		for (const orphan of tempStack) {
			for (const other of allTags) {
				if (other.name !== orphan.name && other.pos > orphan.startPos) {
					enclosureMap[orphan.name].add(other.name);
				}
			}
		}

		// 内联标签判定：出现 >= 2 个闭合对 且 不包含任何其他标签 → 过滤
		const isStructural = {};
		for (const name of uniqueNames) {
			const pairCount = (tagCount[name] || 0) / 2;
			const hasEnclosure = enclosureMap[name] && enclosureMap[name].size > 0;
			isStructural[name] = hasEnclosure || pairCount <= 1;
		}

		// 去除内联标签后重建 enclosure（内联被过滤后，它们的父标签可能也失去 child）
		const structuralNames = uniqueNames.filter(n => isStructural[n]);
		const cleanEnclosure = {};
		for (const name of structuralNames) {
			cleanEnclosure[name] = new Set();
			if (enclosureMap[name]) {
				for (const c of enclosureMap[name]) {
					if (isStructural[c] && c !== name) cleanEnclosure[name].add(c);
				}
			}
		}

		// 找根级标签（不被任何其他结构标签包含的）
		const allChildren = new Set();
		for (const [name, children] of Object.entries(cleanEnclosure)) {
			for (const c of children) allChildren.add(c);
		}
		const roots = structuralNames.filter(n => !allChildren.has(n));
		// 如果所有都是子标签（嵌套极深），全部作为根级
		if (!roots.length) roots.push(...structuralNames);

		// 按首次出现位置排序
		const firstPosMap = {};
		for (const t of allTags) {
			if (!t.isClose && structuralNames.includes(t.name) && !(t.name in firstPosMap)) {
				firstPosMap[t.name] = t.pos;
			}
		}
		roots.sort((a, b) => (firstPosMap[a] ?? 1e9) - (firstPosMap[b] ?? 1e9));

		// 构建缩进树
		const fallbackTree = [];
		const vb = new Set(); // visited
		function walk(name, depth) {
			if (vb.has(name)) return;
			vb.add(name);
			const prefix = '  '.repeat(depth);
			fallbackTree.push(prefix + name);
			const kids = [...(cleanEnclosure[name] || [])].filter(c => !vb.has(c));
			kids.sort((a, b) => (firstPosMap[a] ?? 1e9) - (firstPosMap[b] ?? 1e9));
			for (const kid of kids) walk(kid, depth + 1);
		}
		for (const r of roots) walk(r, 0);

		if (!fallbackTree.length) {
			toastr?.info?.('扫描完成但未能推断标签层级。请手动调整缩进。');
			return;
		}

		const inlineCount = uniqueNames.length - structuralNames.length;
		settings.tagTree = fallbackTree.join('\n');
		$(`#${extensionName}_tree`).val(settings.tagTree);
		saveSettingsDebounced();
		toastr?.success?.(`✅ 标签树已重建（${structuralNames.length} 个结构标签，${inlineCount} 个内联标签已过滤）`);
		return;
	}

	// 有完整闭合对，正常推断父子关系
	for (const parent of ranges) {
		for (const child of ranges) {
			if (child.name !== parent.name && child.start > parent.start && child.end < parent.end) {
				parent.children.add(child.name);
			}
		}
	}

	// 过滤内联标签：多次出现且无子标签 → 视为内联
	const hasChildren = new Set();
	for (const r of ranges) { if (r.children.size > 0) hasChildren.add(r.name); }
	const kept = new Set();
	for (const r of ranges) {
		const count = tagCount[r.name] / 2; // 闭合对数量
		if (hasChildren.has(r.name) || count <= 1) kept.add(r.name);
	}

	// 找根级标签（不被任何结构标签包含）
	const allChildNames = new Set();
	for (const r of ranges) {
		if (kept.has(r.name)) {
			for (const c of r.children) { if (kept.has(c)) allChildNames.add(c); }
		}
	}
	let rootCandidates = ranges.filter(r => kept.has(r.name) && !allChildNames.has(r.name));

	// 回退：如果过滤后根级为空，保留所有标签
	if (!rootCandidates.length) {
		rootCandidates = ranges.filter(r => !allChildNames.has(r.name));
		for (const r of rootCandidates) kept.add(r.name);
	}

	// ===== 去重 + 合并：同名标签只保留一个，children 取并集 =====
	const tagMeta = {}; // { name: { firstPos, children: Set } }
	for (const r of ranges) {
		if (!kept.has(r.name)) continue;
		if (!tagMeta[r.name]) {
			tagMeta[r.name] = { firstPos: r.start, children: new Set() };
		} else if (r.start < tagMeta[r.name].firstPos) {
			tagMeta[r.name].firstPos = r.start;
		}
		for (const c of r.children) {
			if (kept.has(c) && c !== r.name) tagMeta[r.name].children.add(c);
		}
	}

	// 保留孤儿开标签（掉了闭合的标签）：它们可能是一级父标签
	for (const orphan of openStack) {
		if (!tagMeta[orphan.name]) {
			tagMeta[orphan.name] = { firstPos: orphan.start, children: new Set() };
		} else if (orphan.start < tagMeta[orphan.name].firstPos) {
			tagMeta[orphan.name].firstPos = orphan.start;
		}
		for (const r of ranges) {
			if (kept.has(r.name) && r.name !== orphan.name && r.start > orphan.start) {
				tagMeta[orphan.name].children.add(r.name);
			}
		}
	}

	// 补充模式：合并已有配置的标签树（全量替换模式则跳过此步）
	if (!replaceMode) {
		const existingLines = settings.tagTree.split('\n').filter(l => l.trim());
		const indentStack = [];
		for (const line of existingLines) {
			const rawIndent = line.search(/\S/);
			const name = line.trim();
			const depth = rawIndent === 0 ? 0 : Math.max(1, Math.round(rawIndent / 2));
			while (indentStack.length > 0 && indentStack[indentStack.length - 1].depth >= depth) {
				indentStack.pop();
			}
			if (!tagMeta[name]) {
				tagMeta[name] = { firstPos: Infinity, children: new Set() };
			}
			if (indentStack.length > 0 && tagMeta[name]?.firstPos === Infinity) {
				const parent = indentStack[indentStack.length - 1].name;
				if (!tagMeta[parent]) {
					tagMeta[parent] = { firstPos: Infinity, children: new Set() };
				}
				tagMeta[parent].children.add(name);
			}
			indentStack.push({ name, depth });
		}
	}

	// 找去重后的根级标签
	const allChildNamesDedup = new Set();
	for (const [name, meta] of Object.entries(tagMeta)) {
		for (const c of meta.children) allChildNamesDedup.add(c);
	}
	const rootNames = Object.keys(tagMeta).filter(n => !allChildNamesDedup.has(n));
	if (!rootNames.length) {
		rootNames.push(...Object.keys(tagMeta));
	}

	// 按最早出现位置排序（已有标签在 Infinity，排最后）
	rootNames.sort((a, b) => (tagMeta[a]?.firstPos ?? 1e9) - (tagMeta[b]?.firstPos ?? 1e9));

	// 构建缩进树（递归，visited 防止循环）
	const builtTree = [];
	const visited = new Set();
	function addBranch(name, depth) {
		if (visited.has(name)) return;
		visited.add(name);
		const meta = tagMeta[name];
		if (!meta) return;
		const prefix = '  '.repeat(depth);
		builtTree.push(prefix + name);
		const sortedChildren = [...meta.children]
			.filter(c => tagMeta[c] && c !== name)
			.sort((a, b) => (tagMeta[a]?.firstPos ?? 0) - (tagMeta[b]?.firstPos ?? 0));
		for (const childName of sortedChildren) {
			if (visited.has(childName)) continue;
			addBranch(childName, depth + 1);
		}
	}
	for (const rootName of rootNames) { addBranch(rootName, 0); }

	if (!builtTree.length) {
		toastr?.info?.('扫描完成但未能推断标签层级。请手动调整缩进。');
		return;
	}

	const newTree = builtTree.join('\n');
	settings.tagTree = newTree;
	$(`#${extensionName}_tree`).val(settings.tagTree);
	saveSettingsDebounced();

	const structureNames = Object.keys(tagMeta).length;
	const totalNames = new Set(ranges.map(r => r.name)).size;
	toastr?.success?.(`✅ 标签树已重建（${structureNames} 个结构标签，${totalNames - structureNames} 个内联标签已过滤）`);
}

// ========== 栈式算法修复标签（同级互斥、补开补闭 + 残缺标签补全）==========

function fixTagsInText(text) {
	const { allTags: tags, siblings, children } = parseTagTree();
	if (!tags.length) return { text, fixed: 0 };

	const escaped = tags.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

	// ===== 预处理：残缺标签补全（如 </Ad → </Advance>）=====
	let body = text;
	let prepFix = 0;

	// 扫描所有 < 或 </ 后跟不完整标签名的情况
	const partialRe = /<(\/?)([a-zA-Z_][a-zA-Z0-9_.-]*)(?=[^a-zA-Z0-9_.->]|$)/g;
	const partialFixes = []; // [{ pos, oldLen, replacement }]
	let pm;
	while ((pm = partialRe.exec(body)) !== null) {
		const isClose = pm[1] === '/';
		const partialName = pm[2];
		const fullStr = pm[0]; // e.g., "</Adv" or "<Adva"

		// 检查后面是否跟着 >（如果是，则是完整标签，跳过）
		const after = body.slice(pm.index + fullStr.length);
		if (after.match(/^\s*>/)) continue;

		// 检查是否本身就是完整标签名（如 </Advance 后面可能有属性）
		const exactMatch = tags.some(t => t.toLowerCase() === partialName.toLowerCase());
		if (exactMatch) continue; // 名字完整，只是缺了 >，不算残缺

		// 前缀匹配已知标签
		const candidates = tags.filter(t => t.toLowerCase().startsWith(partialName.toLowerCase()));

		if (candidates.length === 1) {
			// 唯一匹配 → 补全
			const complete = isClose ? `</${candidates[0]}>` : `<${candidates[0]}>`;
			partialFixes.push({ pos: pm.index, oldLen: fullStr.length, replacement: complete });
		}
		// 多个匹配 → 不处理（歧义）
	}

	// 从后往前应用补全（保持位置偏移不变）
	partialFixes.sort((a, b) => b.pos - a.pos);
	for (const pf of partialFixes) {
		body = body.slice(0, pf.pos) + pf.replacement + body.slice(pf.pos + pf.oldLen);
		prepFix++;
	}
	// ===== 预处理结束 =====

	// 匹配所有完整标签
	const tagRe = new RegExp(`<\\/?(${escaped.join('|')})\\b[^>]*?(?<!\\/)>`, 'gi');

	const stack = [];         // [{ name }]
	const orphanCloses = [];   // [{ name, pos }] 孤立的闭合标签（需要补开标签）
	const fixPoints = [];      // [{ name, pos }] 需要补闭的位置
	const seenTags = [];       // [{ name, pos, isClose, len }] 所有已匹配的标签位置

	let m;
	while ((m = tagRe.exec(body)) !== null) {
		const full = m[0];
		const name = m[1];
		const pos = m.index;
		const isClose = full.startsWith('</');
		seenTags.push({ name, pos, isClose, len: full.length });

		if (isClose) {
			// 闭合标签：从栈中找匹配的开标签并弹出
			let found = -1;
			for (let i = stack.length - 1; i >= 0; i--) {
				if (stack[i].name.toLowerCase() === name.toLowerCase()) { found = i; break; }
			}
			if (found >= 0) {
				// 弹出该标签及其以上的所有子标签（子标签没闭合 = AI 掉了）
				while (stack.length > found) {
					const popped = stack.pop();
					if (popped.name.toLowerCase() !== name.toLowerCase()) {
						fixPoints.push({ name: popped.name, pos });
					}
				}
			} else {
				orphanCloses.push({ name, pos });
			}
		} else {
			// 开标签：检查同级互斥
			if (siblings.has(name)) {
				for (let i = stack.length - 1; i >= 0; i--) {
					if (siblings.has(stack[i].name) && stack[i].name.toLowerCase() !== name.toLowerCase()) {
						// 从该同级位置到栈顶全部闭合（先子后父）
						while (stack.length > i) {
							const popped = stack.pop();
							fixPoints.push({ name: popped.name, pos });
						}
						break;
					}
				}
			}
			stack.push({ name });
		}
	}

	// ===== 应用补闭：同位置合并为一整块插入（保证内先外后）=====
	fixPoints.sort((a, b) => b.pos - a.pos);
	let fixed = prepFix;

	// 合并同位置的 fixPoints
	const grouped = [];
	for (let i = 0; i < fixPoints.length; i++) {
		if (i === 0 || fixPoints[i].pos !== fixPoints[i - 1].pos) {
			grouped.push({ pos: fixPoints[i].pos, names: [fixPoints[i].name] });
		} else {
			grouped[grouped.length - 1].names.push(fixPoints[i].name);
		}
	}

	// 补开标签（孤儿闭标签）
	const orphanFixPoints = []; // [{ pos, name }]
	const virtualPositions = {}; // { name: pos } 祖先的锚点传给子孙

	// 辅助：nameA 是否是 nameB 的父或祖先
	function isParentOrAncestor(a, b) {
		const kids = children[a];
		if (!kids) return false;
		if (kids.has(b)) return true;
		for (const k of kids) { if (isParentOrAncestor(k, b)) return true; }
		return false;
	}

	// 收集全量子孙
	function getDescendants(name) {
		const result = new Set();
		(function collect(n) {
			const kids = children[n];
			if (!kids) return;
			for (const k of kids) { result.add(k); collect(k); }
		})(name);
		return result;
	}

	// 是否任意层级的兄弟（共享同一父标签）
	function areSiblingsAnyLevel(a, b) {
		for (const kids of Object.values(children)) {
			if (kids.has(a) && kids.has(b)) return true;
		}
		return false;
	}

	// 子孙优先排序：子标签先确定位置，父标签汇总取最早锚点
	orphanCloses.sort((a, b) => {
		if (isParentOrAncestor(a.name, b.name)) return 1;   // a 是父 → a 后处理
		if (isParentOrAncestor(b.name, a.name)) return -1;  // b 是父 → b 后处理
		return 0;
	});

	for (const oc of orphanCloses) {
		const descendants = getDescendants(oc.name);

		// 策略 A：找最早出现的子孙开标签 + 子孙的虚拟锚点，取最小值
		const childHits = seenTags.filter(t => !t.isClose && descendants.has(t.name) && t.pos < oc.pos);
		let earliestPos = childHits.length > 0 ? Math.min(...childHits.map(t => t.pos)) : Infinity;

		// 子孙标签已经被处理过（子孙优先排序），用它们的虚拟锚点作为更早的上界
		for (const [cName, cPos] of Object.entries(virtualPositions)) {
			if (isParentOrAncestor(oc.name, cName) && cPos < earliestPos) {
				earliestPos = cPos;
			}
		}

		if (earliestPos < Infinity) {
			virtualPositions[oc.name] = earliestPos;
			orphanFixPoints.push({ pos: earliestPos, name: oc.name });
			continue;
		}

		// 策略 B：找父/同级开标签锚点
		// 父标签 → 插在它后面；同级标签 → 插在它前面
		let anchorPos = 0;
		for (let i = seenTags.length - 1; i >= 0; i--) {
			const st = seenTags[i];
			if (st.pos >= oc.pos || st.isClose) continue;
			if (isParentOrAncestor(st.name, oc.name)) {
				anchorPos = st.pos + st.len;  // 父标签：插在它开标签后面
				break;
			}
			if (areSiblingsAnyLevel(st.name, oc.name)) {
				anchorPos = st.pos;  // 同级标签：插在它前面
				break;
			}
		}

		// 策略 C：anchorPos 仍为 0 → 用祖先的虚拟锚点
		if (anchorPos === 0) {
			for (const [pName, pPos] of Object.entries(virtualPositions)) {
				if (isParentOrAncestor(pName, oc.name) && pPos > anchorPos) {
					anchorPos = pPos;
				}
			}
		}

		// 锚点钳制：开标签绝不能落在闭标签之后
		if (anchorPos === 0 || anchorPos > oc.pos) {
			anchorPos = 0;
			for (let j = seenTags.length - 1; j >= 0; j--) {
				if (seenTags[j].pos < oc.pos) {
					anchorPos = seenTags[j].pos + seenTags[j].len;
					break;
				}
			}
		}

		virtualPositions[oc.name] = anchorPos;
		orphanFixPoints.push({ pos: anchorPos, name: oc.name });
	}

	// 同位置合并：祖先在前（外先内后），拼成一块插入
	orphanFixPoints.sort((a, b) => {
		if (a.pos !== b.pos) return a.pos - b.pos;
		if (isParentOrAncestor(a.name, b.name)) return -1;
		if (isParentOrAncestor(b.name, a.name)) return 1;
		return 0;
	});
	const mergedOrphans = [];
	for (const o of orphanFixPoints) {
		const last = mergedOrphans[mergedOrphans.length - 1];
		if (last && last.pos === o.pos) { last.names.push(o.name); }
		else { mergedOrphans.push({ pos: o.pos, names: [o.name] }); }
	}

	// 从后往前一次性插入所有修复（闭标签 + 孤儿开标签）
	const allInserts = [...grouped.map(g => ({ pos: g.pos, text: g.names.map(n => `</${n}>\n`).join('') })),
		...mergedOrphans.map(o => ({ pos: o.pos, text: (o.pos > 0 ? '\n' : '') + o.names.map(n => `<${n}>\n`).join('') }))];
	allInserts.sort((a, b) => b.pos - a.pos);

	for (const ins of allInserts) {
		body = body.slice(0, ins.pos) + ins.text + body.slice(ins.pos);
	}
	fixed += grouped.reduce((s, g) => s + g.names.length, 0)
		+ mergedOrphans.reduce((s, o) => s + o.names.length, 0);

	// 尾部补闭合标签（栈中剩余）
	while (stack.length > 0) {
		body += `</${stack.pop().name}>\n`;
		fixed++;
	}

	return { text: body, fixed };
}

// ========== 获取 ST 上下文 ==========

function getContext() {
	try {
		// 标准扩展：从 ST 主窗口获取
		if (window.SillyTavern?.getContext) return window.SillyTavern.getContext();
	} catch (_) {}
	try {
		// 回退：iframe 场景
		if (window.top?.SillyTavern?.getContext) return window.top.SillyTavern.getContext();
	} catch (_) {}
	return null;
}

// ========== 核心：修复最后一条 AI 消息 + 即时渲染 ==========

async function fixLastMessage() {
	try {
		const ctx = getContext();
		if (!ctx?.chat?.length) { toastr?.warning?.('没有聊天消息'); return; }

		// 找最后一条 AI 消息
		let lastIdx = -1;
		for (let i = ctx.chat.length - 1; i >= 0; i--) {
			if (!ctx.chat[i].is_user) { lastIdx = i; break; }
		}
		if (lastIdx < 0) { toastr?.warning?.('未找到AI消息'); return; }

		const lastMsg = ctx.chat[lastIdx];
		const originalText = lastMsg.mes;
		const result = fixTagsInText(originalText);

		if (result.fixed === 0) {
			toastr?.success?.('✅ 所有标签均已正确闭合');
			return;
		}

		console.log(`[TagAutoFixer] 修复了 ${result.fixed} 个标签`);

		// TavernHelper 是 Slash Runner 暴露到 window 的稳定 API
		// setChatMessages 同时负责数据更新 + 保存 + 触发渲染（含 Regex 美化）
		const TH = window.TavernHelper;
		let rendered = false;

		if (TH?.setChatMessages) {
			try {
				await TH.setChatMessages([{ message_id: lastIdx, message: result.text }]);
				rendered = true;
				console.log('[TagAutoFixer] 通过 TavernHelper.setChatMessages 触发渲染');
			} catch (e) {
				console.warn('[TagAutoFixer] TavernHelper.setChatMessages 失败:', e);
			}
		}

		if (!rendered && TH?.refreshOneMessage) {
			// 回退：手动写数据 + 保存 + 单独触发渲染
			try {
				lastMsg.mes = result.text;
				if (ctx.saveChat) await ctx.saveChat();
				await TH.refreshOneMessage(lastIdx);
				rendered = true;
				console.log('[TagAutoFixer] 通过 TavernHelper.refreshOneMessage 触发渲染');
			} catch (e) {
				console.warn('[TagAutoFixer] refreshOneMessage 失败:', e);
			}
		}

		if (!rendered) {
			// 最后回退：手动保存 + DOM
			lastMsg.mes = result.text;
			if (ctx.saveChat) await ctx.saveChat();
			console.log('[TagAutoFixer] 已保存数据但未能触发渲染');
		}

		toastr?.success?.(rendered
			? `✅ 已修复 ${result.fixed} 个标签`
			: `✅ 已修复 ${result.fixed} 个标签（可能需要切换聊天以刷新显示）`);

	} catch (e) {
		console.error('[TagAutoFixer] 修复失败:', e);
		toastr?.error?.('修复失败，请查看控制台（F12 → Console）');
	}
}

// ========== 初始化 ==========

jQuery(async () => {
	const ctx = getContext();

	// 注册斜杠命令 /fix-tags
	if (ctx?.SlashCommandParser) {
		try {
			ctx.SlashCommandParser.addCommand('fix-tags', fixLastMessage,
				['fix-tags', '修复标签'],
				'自动修复AI输出中缺失的标签闭合', true, true);
		} catch (e) {
			console.warn('[TagAutoFixer] 斜杠命令注册失败（可能非 JS-Slash-Runner 环境）:', e);
		}
	}

	// 注入发送按钮旁的修复图标
	const btnId = `${extensionName}_send_btn`;
	const btnHtml = `<div id="${btnId}" class="fa-solid fa-tag interactable" title="修复标签" style="cursor:pointer;padding:0 6px;font-size:1.05em;opacity:0.65"></div>`;
	const left = $('#leftSendForm'), right = $('#rightSendForm');
	const target = left.length ? left : (right.length ? right : null);
	if (target) {
		target.prepend(btnHtml);
		$(`#${btnId}`).on('click', async () => { await fixLastMessage(); });
	}

	// 注入设置面板
	const h = `
<div class="extension-settings" id="${extensionName}_s">
<div class="inline-drawer">
<div class="inline-drawer-toggle inline-drawer-header">
<b>Tag Auto Fixer</b>
<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
</div>
<div class="inline-drawer-content" style="display:none">

<p style="font-size:0.8em;color:var(--grey_color);margin-bottom:6px">
📌 缩进 = 嵌套。不缩进的互为<b>同级</b>（遇到新同级自动闭合旧同级）。
🔍 扫描时直接覆盖树，新模块自动归位。
</p>

<textarea id="${extensionName}_tree" class="text_pole" style="width:100%;height:220px;font-family:monospace">${settings.tagTree}</textarea>

	<div style="display:flex;gap:6px;margin-top:6px">
	<button id="${extensionName}_scan_replace" class="menu_button" style="flex:1;padding:6px;font-size:0.9em">🔄 全量替换扫描</button>
	<button id="${extensionName}_scan_append" class="menu_button" style="flex:1;padding:6px;font-size:0.9em">📎 补充扫描</button>
	</div>
	<button id="${extensionName}_btn" class="menu_button" style="width:100%;padding:6px;font-size:0.9em;margin-top:4px">🔧 修复最后一条消息</button>

<p style="margin-top:6px;font-size:0.8em;color:var(--grey_color)">
也可用 <code>/fix-tags</code> 或点发送按钮旁 🏷️ 图标
</p>

</div></div></div>`;

	$('#extensions_settings').append(h);

	// 监听标签树编辑
	$(`#${extensionName}_tree`).on('input', function() {
		settings.tagTree = $(this).val();
		saveSettingsDebounced();
	});

	// 绑定按钮
	$(`#${extensionName}_scan_replace`).on('click', () => scanAndFill(true));
	$(`#${extensionName}_scan_append`).on('click', () => scanAndFill(false));
	$(`#${extensionName}_btn`).on('click', async () => { await fixLastMessage(); });
	$(`#${extensionName}_reset`).on('click', () => {
		settings.tagTree = defaultTagTree;
		$(`#${extensionName}_tree`).val(defaultTagTree);
		saveSettingsDebounced();
		toastr?.success?.('✅ 已重置为默认标签树');
	});
});
