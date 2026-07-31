import { extension_settings } from "../../../extensions.js";
// eventSource / event_types：script.js 已 re-export（SillyTavern/public/script.js 第 325-326 行）
// 供「每轮输出结束自动修」监听 MESSAGE_RECEIVED 事件
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";

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

// HTML 黑名单默认值：扫描时跳过这些名字，避免 AI 随手生成的 HTML 混进标签树。
// 可在设置面板里增删；若某名字已写进标签树（如 RP 标签 I 恰好叫 I），永远不会被滤。
const DEFAULT_HTML_BLACKLIST = [
	'html', 'head', 'body', 'div', 'span', 'p', 'b', 'i', 'em', 'strong', 'u', 's',
	'small', 'sub', 'sup', 'br', 'hr', 'a', 'img', 'ul', 'ol', 'li', 'table', 'tr',
	'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code',
	'section', 'article', 'nav', 'footer', 'header', 'aside', 'form', 'input',
	'button', 'label', 'select', 'option', 'style', 'script', 'meta', 'link',
	'title', 'font', 'center', 'marquee', 'abbr', 'cite', 'mark', 'ins', 'del',
	'kbd', 'samp', 'var', 'q', 'iframe', 'video', 'audio', 'caption', 'tbody',
	'thead', 'tfoot', 'col', 'colgroup', 'fieldset', 'legend', 'textarea', 'details',
	'summary', 'dialog', 'main', 'figure', 'figcaption', 'picture', 'source', 'track',
];

const defaultSettings = {
	tagTree: defaultTagTree,
	showInlineBtn: true,
	showFloatingBtn: false,
	showMenuBtn: true,
	autoFixEnabled: false,   // 每轮输出结束自动修（默认关，谨慎勾选）
	wrapMissingEnabled: false, // 智能补全：标签整块丢失时推断补回（默认关，谨慎勾选）
	htmlBlacklist: DEFAULT_HTML_BLACKLIST.join('\n'), // 扫描时跳过的 HTML 标签（可增删）
};
if (!extension_settings[extensionName]) extension_settings[extensionName] = defaultSettings;
const settings = extension_settings[extensionName];
if (!settings.tagTree) settings.tagTree = defaultTagTree;
if (settings.showInlineBtn === undefined) settings.showInlineBtn = true;
if (settings.showFloatingBtn === undefined) settings.showFloatingBtn = false;
if (settings.showMenuBtn === undefined) settings.showMenuBtn = true;
if (settings.autoFixEnabled === undefined) settings.autoFixEnabled = false;
if (settings.wrapMissingEnabled === undefined) settings.wrapMissingEnabled = false;
if (settings.htmlBlacklist === undefined) settings.htmlBlacklist = DEFAULT_HTML_BLACKLIST.join('\n');

// ========== 解析标签树（缩进 → 嵌套层级）==========

// 缩进 → 嵌套层级：1 个 Tab = 1 层，2 个空格 = 1 层。
// 修复：旧逻辑 Math.round(空白字符数 / 2) 对 Tab 缩进会把多级（如 \t\tR）拉平到同级，
//       导致 R 被误判为 todo 的同级而非子级。这里按"Tab 即一层、两空格即一层"精确换算。
function indentLevel(line) {
	const m = line.match(/^[ \t]*/);
	if (!m || m[0].length === 0) return 0;
	let level = 0;
	for (const ch of m[0]) level += (ch === '\t') ? 1 : 0.5;
	return Math.max(1, Math.round(level));
}

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

		const depth = indentLevel(line);
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

	// 挖空 <extra>...</extra> 的内部（保留 extra 标签本身）：
	// 用户格式约定——HTML/杂物永远放在 extra 里，所以 extra 内部的一切标签都不进扫描。
	// 这是结构性方案：不依赖具体名字，AI 在 extra 里生成什么噪音都能被挡掉。
	clean = clean.replace(/(<extra(?:\s[^>]*)?>)[\s\S]*?(<\/extra(?:\s[^>]*)?>)/gi, '$1$2');

	// HTML 黑名单：从设置读取（设置面板可增删）。扫描时跳过这些名字，避免 AI 随手生成的 <b>/<i>/<div>/<br> 混进标签树。
	// 规则：名字已在"当前标签树"里声明的（如 RP 标签 I 恰好叫 I）→ 永不滤，尊重用户自己的结构标签。
	const HTML_TAGS = new Set((settings.htmlBlacklist || '').split(/[\s,]+/).filter(Boolean));
	const treeNames = new Set(settings.tagTree.split('\n').map(l => l.trim()).filter(Boolean));

	// 拆出所有标签事件（排除自闭合 <.../> 和未声明为结构标签的 HTML 标签）
	const tagRe = /<\/?([a-zA-Z_][a-zA-Z0-9_.-]*)\b[^>]*?(?<!\/)>/g;
	const allTags = [];
	const tagCount = {};

	let m;
	while ((m = tagRe.exec(clean)) !== null) {
		const name = m[1];
		if (HTML_TAGS.has(name.toLowerCase()) && !treeNames.has(name)) continue; // 跳过 HTML 标签（树内已声明的不滤）
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
			const depth = indentLevel(line);
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

// ========== 智能补全：补回「连开带闭整个丢失」的标签块 ==========
// 仅当 settings.wrapMissingEnabled 为 true 时由 fixTagsInText 调用。
// 触发条件（全部满足才补，缺一不可）：
//   1. 该标签在整条消息里完全没有出现（开标签和闭标签一起丢了）；
//   2. 且满足下面两者之一：
//      a. 祖先补全：它的某个子/孙标签出现了 → 把子标签连成的连续区域包进它；
//      b. 夹逼补全：它的前兄弟、后兄弟都完整闭合，中间恰好只缺它一个 → 把夹逼区间包进它。
// 安全保证：结构正确的消息（该标签还在文里）永远不会被本函数改动；
//           只有本来就缺了整块的坏消息才会被补。

function wrapMissingTags(body, tags, siblings, children) {
	const escaped = tags.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
	const tagRe = new RegExp(`<\\/?(${escaped.join('|')})\\b[^>]*?(?<!\\/)>`, 'gi');

	// 树的嵌套深度（用于"从内到外"处理，先补最里层，外层再包住里层）
	const depthMap = {};
	for (const root of siblings) {
		depthMap[root] = 0;
		(function walk(n, d) {
			for (const k of (children[n] || [])) { depthMap[k] = d + 1; walk(k, d + 1); }
		})(root, 0);
	}

	// 父映射：查某标签的兄弟组（顶层组 = siblings；非顶层组 = 其父的直接子集）
	const parentMap = {};
	for (const root of siblings) parentMap[root] = null;
	for (const [p, kids] of Object.entries(children)) {
		for (const k of kids) parentMap[k] = p;
	}
	function siblingGroup(name) {
		const p = parentMap[name];
		return p === null ? [...siblings] : [...(children[p] || [])];
	}

	// 某标签的全量子孙（不含自身）
	function descendantsOf(name) {
		const out = new Set();
		(function collect(n) {
			for (const k of (children[n] || [])) { out.add(k); collect(k); }
		})(name);
		return out;
	}

	// 扫描当前文本中的树内标签事件
	function scanEvents(str) {
		const evs = [];
		let m;
		const re = new RegExp(tagRe.source, tagRe.flags);
		while ((m = re.exec(str)) !== null) {
			evs.push({ name: m[1], pos: m.index, len: m[0].length, isClose: m[0].startsWith('</') });
		}
		return evs;
	}

	// 祖先补全：把"不被同级兄弟打断"的连续子标签区域，逐段包进缺失的父标签
	function wrapAncestor(text, miss, descSet, blockers) {
		const evs = scanEvents(text);
		const segs = [];
		let curStart = -1, curEnd = -1, curClosed = false;
		for (const e of evs) {
			if (descSet.has(e.name)) {
				if (curStart < 0) {
					// 段必须从一个"开标签"开始（孤立闭合不开启新段）
					if (!e.isClose) { curStart = e.pos; curEnd = e.pos + e.len; curClosed = false; }
				} else {
					curEnd = e.pos + e.len;
					if (e.isClose) curClosed = true;
				}
			} else if (curStart >= 0 && blockers.has(e.name)) {
				if (curClosed) segs.push({ sPos: curStart, ePos: curEnd });
				curStart = -1; curEnd = -1; curClosed = false;
			}
		}
		if (curStart >= 0 && curClosed) segs.push({ sPos: curStart, ePos: curEnd });
		if (!segs.length) return { text, added: 0 };

		// 从后往前插入，保证位置偏移不串
		segs.sort((a, b) => b.sPos - a.sPos);
		let added = 0;
		for (const seg of segs) {
			// 去掉段尾多余空白，避免拼出双换行
			const inner = text.slice(seg.sPos, seg.ePos).replace(/\s+$/, '');
			text = text.slice(0, seg.sPos) + `<${miss}>\n` + inner + `\n</${miss}>` + text.slice(seg.ePos);
			added += 2;
		}
		return { text, added };
	}

	// 判断某标签是否在文本中"恰好一对、完整闭合"
	function isFullPair(name, evs) {
		let open = 0, close = 0;
		for (const e of evs) {
			if (e.name === name) (e.isClose ? close++ : open++);
		}
		return open === 1 && close === 1;
	}
	function lastCloseEnd(name, evs) {
		let pos = -1;
		for (const e of evs) if (e.name === name && e.isClose) pos = e.pos + e.len;
		return pos;
	}
	function firstOpenPos(name, evs) {
		for (const e of evs) if (e.name === name && !e.isClose) return e.pos;
		return -1;
	}

	// 夹逼补全：前兄弟闭合、后兄弟闭合、中间恰好只缺这一个标签 → 包夹逼区间
	function wrapSandwich(text, miss, group) {
		const evs = scanEvents(text);
		const idx = group.indexOf(miss);
		if (idx < 0) return { text, added: 0 };

		let li = -1, ri = -1;
		for (let i = idx - 1; i >= 0; i--) if (isFullPair(group[i], evs)) { li = i; break; }
		for (let i = idx + 1; i < group.length; i++) if (isFullPair(group[i], evs)) { ri = i; break; }
		if (li < 0 || ri < 0) return { text, added: 0 };

		// 左右之间的兄弟，除 miss 外若还有缺失 → 无法归属，跳过
		const present = new Set(evs.map(e => e.name));
		for (let i = li + 1; i < ri; i++) {
			if (i !== idx && !present.has(group[i])) return { text, added: 0 };
		}

		const leftEnd = lastCloseEnd(group[li], evs);
		const rightStart = firstOpenPos(group[ri], evs);
		if (leftEnd < 0 || rightStart < 0 || leftEnd > rightStart) return { text, added: 0 };

		const region = text.slice(leftEnd, rightStart);
		const trimmed = region.replace(/^\s+|\s+$/g, '');
		if (!trimmed) return { text, added: 0 }; // 空壳不包

		// 区间里若还夹着其它树内标签（非左右锚点）→ 可能吞并别的内容，跳过
		const regionPresent = new Set(scanEvents(region).map(e => e.name));
		for (const nm of regionPresent) {
			if (nm !== group[li] && nm !== group[ri]) return { text, added: 0 };
		}

		text = text.slice(0, leftEnd) + `\n<${miss}>\n` + trimmed + `\n</${miss}>\n` + text.slice(rightStart);
		return { text, added: 2 };
	}

	// ===== 主流程：处理所有缺失标签，从最深到最浅 =====
	let text = body;
	let added = 0;

	const initialEvents = scanEvents(text);
	const present = new Set(initialEvents.map(e => e.name));
	const missing = tags.filter(t => !present.has(t) && t in depthMap);
	missing.sort((a, b) => (depthMap[b] || 0) - (depthMap[a] || 0));

	for (const miss of missing) {
		const descSet = descendantsOf(miss);
		const group = siblingGroup(miss);
		const blockers = new Set(group.filter(n => n !== miss));
		const hasPresentDesc = scanEvents(text).some(e => descSet.has(e.name));

		let r;
		if (hasPresentDesc) {
			r = wrapAncestor(text, miss, descSet, blockers);
		} else {
			r = wrapSandwich(text, miss, group);
		}
		text = r.text;
		added += r.added;
	}

	return { text, added };
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

	// ===== 智能补全（谨慎勾选）：补回"连开带闭整个丢失"的标签块 =====
	// 只对"树里存在、但全文一次都没出现"的标签动手；结构正确的消息不受影响。
	if (settings.wrapMissingEnabled) {
		const wrapResult = wrapMissingTags(body, tags, siblings, children);
		body = wrapResult.text;
		fixed += wrapResult.added;
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

// 统一的"写入 + 渲染 + 记录撤销"入口。手动修复和自动修复都走这里。
// TavernHelper 是 Slash Runner 暴露到 window 的稳定 API；
// setChatMessages 同时负责数据更新 + 保存 + 触发渲染（含 Regex 美化）。
async function applyFixedMessage(ctx, messageId, text, recordUndo = true) {
	if (recordUndo) {
		// fixed 记录写入后的文本，供回退前校验消息是否已被再次改动（防覆盖新内容）
		undoSlot = { chatId: ctx.chatId ?? null, messageId, original: ctx.chat[messageId]?.mes ?? null, fixed: text };
		updateUndoBtn();
	}

	let rendered = false;
	const TH = window.TavernHelper;

	if (TH?.setChatMessages) {
		try {
			await TH.setChatMessages([{ message_id: messageId, message: text }]);
			rendered = true;
		} catch (e) {
			console.warn('[TagAutoFixer] TavernHelper.setChatMessages 失败:', e);
		}
	}

	if (!rendered && TH?.refreshOneMessage) {
		// 回退：手动写数据 + 保存 + 单独触发渲染
		try {
			if (ctx.chat[messageId]) ctx.chat[messageId].mes = text;
			if (ctx.saveChat) await ctx.saveChat();
			await TH.refreshOneMessage(messageId);
			rendered = true;
		} catch (e) {
			console.warn('[TagAutoFixer] refreshOneMessage 失败:', e);
		}
	}

	if (!rendered) {
		// 最后回退：手动保存数据（可能无法即时刷新显示）
		if (ctx.chat[messageId]) ctx.chat[messageId].mes = text;
		if (ctx.saveChat) await ctx.saveChat();
	}

	return rendered;
}

// ========== 撤销：回退上一次修复 ==========

let undoSlot = null; // { chatId, messageId, original }（单槽，只记最近一次）

const undoBtnId = `${extensionName}_undo_btn`;      // 主页面右下角浮动按钮（修过之后才出现）
const undoPanelBtnId = `${extensionName}_undo_panel`; // 设置面板常驻按钮（有可回退内容才可点）
function updateUndoBtn() {
	$(`#${undoBtnId}`).remove();
	const ctx = getContext();
	// 用 chatId 隔离聊天：切到别的聊天就算作废
	let valid = false;
	if (undoSlot && ctx) {
		const sameChat = !undoSlot.chatId || !ctx.chatId || undoSlot.chatId === ctx.chatId;
		valid = sameChat && !!ctx.chat?.[undoSlot.messageId];
	}

	// 面板常驻按钮状态同步
	const $panelBtn = $(`#${undoPanelBtnId}`);
	if ($panelBtn.length) {
		$panelBtn.prop('disabled', !valid).css('opacity', valid ? 1 : 0.4);
	}

	// 主页面右下角浮动按钮：仅在有可回退项时显示
	if (!valid) return;
	$('body').append(`<div id="${undoBtnId}" title="回退上一次修复" style="
		position:fixed;bottom:130px;right:20px;z-index:9999;
		background:var(--golden-color, #e0a800);color:#fff;
		border-radius:16px;padding:6px 14px;font-size:13px;cursor:pointer;
		box-shadow:0 2px 8px rgba(0,0,0,0.35);user-select:none;opacity:0.95
	">↩️ 回退修复</div>`);
	$(`#${undoBtnId}`).on('click', async () => { await undoLastFix(); });
}

async function undoLastFix() {
	if (!undoSlot) { toastr?.info?.('没有可回退的修复'); return; }
	const ctx = getContext();
	if (!ctx) { toastr?.warning?.('无法获取聊天上下文'); return; }
	const slot = undoSlot;

	if (slot.chatId && ctx.chatId && slot.chatId !== ctx.chatId) {
		undoSlot = null; updateUndoBtn();
		toastr?.info?.('已切换聊天，上次修复无法回退');
		return;
	}
	if (!ctx.chat[slot.messageId]) {
		undoSlot = null; updateUndoBtn();
		toastr?.warning?.('消息不存在或已被删除');
		return;
	}
	// 防呆：消息已被重生成 / 滑动 / 手动编辑过 → 不再用旧文本覆盖
	if (slot.fixed !== undefined && ctx.chat[slot.messageId].mes !== slot.fixed) {
		undoSlot = null; updateUndoBtn();
		toastr?.info?.('该消息已被改动过，无法回退（自动作废）');
		return;
	}

	const rendered = await applyFixedMessage(ctx, slot.messageId, slot.original, false);
	undoSlot = null;
	updateUndoBtn();
	toastr?.success?.(rendered ? '✅ 已回退到修复前' : '✅ 已回退（可能需要切换聊天以刷新显示）');
}

// ========== 自动修复：每轮 AI 输出结束自动修 ==========
// 事件签名：MESSAGE_RECEIVED (message_id, type)，见 public/scripts/events.js。
// 触发时机：AI 消息完整落盘后（流式 script.js:3740 / 非流式 script.js:6632）。
// emit 会 await 本监听器，因此修复 + 重渲染先于 ST 自身渲染完成：无闪烁、无二次冲突。
// setChatMessages 只触发 MESSAGE_UPDATED、不会触发 MESSAGE_RECEIVED → 不会死循环。

function registerAutoFix() {
	eventSource.on(event_types.MESSAGE_RECEIVED, async (messageId) => {
		if (!settings.autoFixEnabled) return;
		try {
			const ctx = getContext();
			if (!ctx?.chat?.length) return;
			if (!Number.isInteger(messageId) || messageId < 0 || messageId >= ctx.chat.length) return;
			const mes = ctx.chat[messageId];
			if (!mes || mes.is_user) return; // 不碰用户消息（含 impersonate 生成的用户消息）
			if (typeof mes.mes !== 'string' || !mes.mes.includes('<')) return; // 无标签快速跳过
			const result = fixTagsInText(mes.mes);
			if (result.fixed === 0) return;
			const rendered = await applyFixedMessage(ctx, messageId, result.text);
			console.log(`[TagAutoFixer] 自动修复 ${result.fixed} 个标签 (message ${messageId})`);
			toastr?.success?.(rendered
				? `✅ 自动修复 ${result.fixed} 个标签`
				: `✅ 自动修复 ${result.fixed} 个标签（可能需要切换聊天以刷新显示）`);
		} catch (e) {
			console.error('[TagAutoFixer] 自动修复失败:', e);
		}
	});
}

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
		const result = fixTagsInText(lastMsg.mes);

		if (result.fixed === 0) {
			toastr?.success?.('✅ 所有标签均已正确闭合');
			return;
		}

		console.log(`[TagAutoFixer] 修复了 ${result.fixed} 个标签`);
		const rendered = await applyFixedMessage(ctx, lastIdx, result.text);
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

	// 内联按钮：发送按钮旁的小图标
	const inlineBtnId = `${extensionName}_send_btn`;
	function updateInlineBtn() {
		$(`#${inlineBtnId}`).remove();
		if (!settings.showInlineBtn) return;
		const btnHtml = `<div id="${inlineBtnId}" class="fa-solid fa-tag interactable" title="修复标签" style="cursor:pointer;padding:0 3px;font-size:0.7em;opacity:0.5;margin-right:1px"></div>`;
		const left = $('#leftSendForm'), right = $('#rightSendForm');
		const target = left.length ? left : (right.length ? right : null);
		if (target) {
			target.prepend(btnHtml);
			$(`#${inlineBtnId}`).on('click', async () => { await fixLastMessage(); });
		}
	}
	updateInlineBtn();

	// 悬浮按钮（可拖拽）
	const floatBtnId = `${extensionName}_float_btn`;
	function updateFloatingBtn() {
		$(`#${floatBtnId}`).remove();
		if (!settings.showFloatingBtn) return;
		$('body').append(`<div id="${floatBtnId}" title="修复标签（可拖拽）" style="
			position:fixed;bottom:80px;right:20px;z-index:9999;
			width:36px;height:36px;border-radius:50%;background:var(--accent-color, #888);
			color:#fff;display:flex;align-items:center;justify-content:center;
			cursor:grab;box-shadow:0 2px 8px rgba(0,0,0,0.3);font-size:14px;
			opacity:0.7;user-select:none;
		">🏷️</div>`);

		const $btn = $(`#${floatBtnId}`);
		let dragging = false, dx = 0, dy = 0, startX, startY;

		$btn.on('mousedown touchstart', function(e) {
			dragging = false;
			const ev = e.touches ? e.touches[0] : e;
			startX = ev.clientX;
			startY = ev.clientY;
			const pos = $btn.position();
			dx = startX - pos.left;
			dy = startY - pos.top;
			$btn.css({ cursor: 'grabbing', opacity: '1', transition: 'none' });
		});

		$(document).on('mousemove touchmove', function(e) {
			if (!$btn[0] || dx === undefined) return;
			const ev = e.touches ? e.touches[0] : e;
			if (Math.abs(ev.clientX - startX) > 3 || Math.abs(ev.clientY - startY) > 3) {
				dragging = true;
			}
			if (dragging) {
				e.preventDefault();
				$btn.css({ left: (ev.clientX - dx) + 'px', top: (ev.clientY - dy) + 'px', right: 'auto', bottom: 'auto' });
			}
		});

		$(document).on('mouseup touchend', function() {
			if ($btn[0]) {
				$btn.css({ cursor: 'grab', opacity: '0.7', transition: 'opacity 0.2s' });
			}
			dx = undefined;
		});

		$btn.on('click', async function() {
			if (!dragging) await fixLastMessage();
		});
	}
	updateFloatingBtn();

	// 扩展菜单项（#extensionsMenu 内）
	const menuItemId = `${extensionName}_menu_item`;
	function updateMenuItem() {
		$(`#${menuItemId}`).remove();
		if (!settings.showMenuBtn) return;
		const $menu = $('#extensionsMenu');
		if (!$menu.length) return;
		$menu.append(`<a id="${menuItemId}" class="list-group-item" href="#" title="修复标签">
			<i class="fa-solid fa-tag"></i> 修复标签
		</a>`);
		$(`#${menuItemId}`).on('click', async (e) => {
			e.preventDefault();
			e.stopPropagation();
			$('#extensionsMenu').fadeOut(200);
			await fixLastMessage();
		});
	}
	// 延迟注入等菜单就绪
	setTimeout(updateMenuItem, 1000);

	// 注入设置面板
	const h = `
<div class="extension-settings" id="${extensionName}_s">
<div class="inline-drawer">
<div class="inline-drawer-toggle inline-drawer-header">
<b>一键标签修复</b>
<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
</div>
<div class="inline-drawer-content" style="display:none">

<p style="font-size:0.8em;color:var(--grey_color);margin-bottom:6px">
📌 缩进 = 嵌套。不缩进的互为<b>同级</b>（遇到新同级自动闭合旧同级）。
🔍 扫描时直接覆盖树，新模块自动归位。
</p>

<textarea id="${extensionName}_tree" class="text_pole" style="width:100%;height:220px;font-family:monospace">${settings.tagTree}</textarea>

	<p style="margin-top:6px;font-size:0.8em;color:var(--grey_color)">
	🔻 <span id="${extensionName}_htmlbl_toggle" style="cursor:pointer">HTML 黑名单（点击展开/收起）</span>
	</p>
	<div id="${extensionName}_htmlbl_box" style="display:none">
	<textarea id="${extensionName}_htmlbl" class="text_pole" style="width:100%;height:80px;font-family:monospace">${settings.htmlBlacklist}</textarea>
	<div style="display:flex;gap:6px;margin-top:4px">
	<button id="${extensionName}_htmlbl_reset" class="menu_button" style="flex:1;padding:4px;font-size:0.8em">↺ 恢复默认</button>
	</div>
	<p style="font-size:0.7em;color:var(--grey_color);margin-top:3px;line-height:1.5">
	扫描时跳过这些标签（一个一行，空格也行）。<b>已写进上面标签树的名字永远不会被滤</b>；
	想用黑名单里的名字当自己的标签 → 把它加进标签树即可，或直接删掉这一行。
	</p>
	</div>

	<div style="display:flex;gap:6px;margin-top:6px">
	<button id="${extensionName}_scan_replace" class="menu_button" style="flex:1;padding:6px;font-size:0.9em">🔄 全量替换扫描</button>
	<button id="${extensionName}_scan_append" class="menu_button" style="flex:1;padding:6px;font-size:0.9em">📎 补充扫描</button>
	</div>
	<button id="${extensionName}_btn" class="menu_button" style="width:100%;padding:6px;font-size:0.9em;margin-top:4px">🔧 修复最后一条消息</button>
	<button id="${extensionName}_undo_panel" class="menu_button" style="width:100%;padding:6px;font-size:0.9em;margin-top:4px" disabled>↩️ 回退上一次修复</button>
	<button id="${extensionName}_reset" class="menu_button" style="width:100%;padding:6px;font-size:0.9em;margin-top:4px">↺ 重置为默认标签树</button>

	<div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--grey_outline, rgba(128,128,128,.2))">
	<div style="display:flex;gap:16px;align-items:center;font-size:0.8em;flex-wrap:wrap">
	<label style="cursor:pointer;display:flex;align-items:center;gap:4px"><input type="checkbox" id="${extensionName}_chk_auto" ${settings.autoFixEnabled ? 'checked' : ''}> 每轮自动修复</label>
	<label style="cursor:pointer;display:flex;align-items:center;gap:4px"><input type="checkbox" id="${extensionName}_chk_wrap" ${settings.wrapMissingEnabled ? 'checked' : ''}> 前后标签都丢时补全</label>
	</div>
	<div id="${extensionName}_warn_auto" style="display:none;margin-top:5px;font-size:0.75em;color:var(--golden-color, #e0a800);line-height:1.5">
	⚠️ <b>每轮自动修复</b>＝每轮 AI 回复完自动修一遍标签。没标签的消息不会动；保险起见，出问题点右上「↩️ 回退修复」。
	</div>
	<div id="${extensionName}_warn_wrap" style="display:none;margin-top:5px;font-size:0.75em;color:var(--golden-color, #e0a800);line-height:1.5">
	⚠️ <b>谨慎使用</b>。勾选前请先：① 用扫描功能把标签树扫准确；② 确认消息里的内容都有标签包着。<br>
	功能＝标签<b>连开带闭整对丢失</b>时（如 <code>&lt;Advance&gt;...&lt;/Advance&gt;</code> 整对没了，只剩里面的 choice），靠标签树和前后邻居猜着补回来。偶尔可能猜错，出问题点右上「↩️ 回退修复」。
	</div>
	</div>

	<div style="margin-top:8px;font-size:0.8em;display:flex;gap:12px;align-items:center">
	<label style="cursor:pointer"><input type="checkbox" id="${extensionName}_chk_inline" ${settings.showInlineBtn ? 'checked' : ''}> 输入框旁</label>
	<label style="cursor:pointer"><input type="checkbox" id="${extensionName}_chk_float" ${settings.showFloatingBtn ? 'checked' : ''}> 悬浮按钮</label>
	<label style="cursor:pointer"><input type="checkbox" id="${extensionName}_chk_menu" ${settings.showMenuBtn ? 'checked' : ''}> 扩展菜单</label>
	</div>

<p style="margin-top:6px;font-size:0.8em;color:var(--grey_color)">
也可用 <code>/fix-tags</code> 斜杠命令
</p>

</div></div></div>`;

	$('#extensions_settings').append(h);

	// 监听标签树编辑
	$(`#${extensionName}_tree`).on('input', function() {
		settings.tagTree = $(this).val();
		saveSettingsDebounced();
	});

	// HTML 黑名单：展开/收起 + 编辑 + 恢复默认
	$(`#${extensionName}_htmlbl_toggle`).on('click', () => { $(`#${extensionName}_htmlbl_box`).slideToggle(150); });
	$(`#${extensionName}_htmlbl`).on('input', function() {
		settings.htmlBlacklist = $(this).val();
		saveSettingsDebounced();
	});
	$(`#${extensionName}_htmlbl_reset`).on('click', () => {
		settings.htmlBlacklist = DEFAULT_HTML_BLACKLIST.join('\n');
		$(`#${extensionName}_htmlbl`).val(settings.htmlBlacklist);
		saveSettingsDebounced();
		toastr?.success?.('✅ 已恢复默认 HTML 黑名单');
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

	// UI 模式切换
	$(`#${extensionName}_chk_inline`).on('change', function() {
		settings.showInlineBtn = this.checked;
		saveSettingsDebounced();
		updateInlineBtn();
	});
	$(`#${extensionName}_chk_float`).on('change', function() {
		settings.showFloatingBtn = this.checked;
		saveSettingsDebounced();
		updateFloatingBtn();
	});
	$(`#${extensionName}_chk_menu`).on('change', function() {
		settings.showMenuBtn = this.checked;
		saveSettingsDebounced();
		updateMenuItem();
	});

	// 新功能勾选框
	$(`#${extensionName}_chk_auto`).on('change', function() {
		settings.autoFixEnabled = this.checked;
		$(`#${extensionName}_warn_auto`).toggle(this.checked);
		saveSettingsDebounced();
	});
	$(`#${extensionName}_chk_wrap`).on('change', function() {
		settings.wrapMissingEnabled = this.checked;
		$(`#${extensionName}_warn_wrap`).toggle(this.checked);
		saveSettingsDebounced();
	});
	// 若之前已勾选，初始就展开对应说明
	if (settings.autoFixEnabled) $(`#${extensionName}_warn_auto`).show();
	if (settings.wrapMissingEnabled) $(`#${extensionName}_warn_wrap`).show();

	// 常驻"回退上一次修复"按钮
	$(`#${extensionName}_undo_panel`).on('click', async () => { await undoLastFix(); });

	// 自动修复监听（每轮 AI 输出结束自动修）
	registerAutoFix();
	// 切换聊天时，隐藏上一个聊天的"回退修复"按钮
	eventSource.on(event_types.CHAT_CHANGED, () => updateUndoBtn());
});
