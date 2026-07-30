import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "tag_auto_fixer";
const defaultTagTree = `scene
	content
	Danmaku
	Advance
	  choice
	  todo
	  remind
	  status
	Events
	summary
	extra
	NG_scene
	lts`;

const defaultSettings = { tagTree: defaultTagTree };
if (!extension_settings[extensionName]) extension_settings[extensionName] = defaultSettings;
const settings = extension_settings[extensionName];
if (!settings.tagTree) settings.tagTree = defaultTagTree;

// ========== 解析标签树（缩进 → 嵌套层级）==========

function parseTagTree() {
	const lines = settings.tagTree.split('\n').filter(l => l.trim());
	const allTags = new Set();
	const siblings = new Set();
	for (const line of lines) {
		const indent = line.search(/\S/);
		const name = line.trim();
		allTags.add(name);
		if (indent === 0) siblings.add(name);
	}
	return { allTags: [...allTags], siblings };
}

// ========== 扫描消息、重建标签树 ==========

function scanAndFill() {
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
		// AI 可能掉了闭合标签，尝试从孤儿标签推断结构
		const uniqueNames = [...new Set(allTags.map(t => t.name))];
		console.log('[TagAutoFixer] 未找到完整闭合对，尝试从孤儿标签推断。检测到的标签:', uniqueNames);

		// 统计每种标签的出现次数（开标签次数）
		const openCounts = {};
		for (const t of allTags) {
			if (!t.isClose) {
				openCounts[t.name] = (openCounts[t.name] || 0) + 1;
			}
		}

		// 推论：出现 2 次以上的大概率是结构标签；只出现 1 次的也可能是嵌套子标签
		// 简化策略：把所有检测到的标签都列出来，按出现次数排序
		const candidates = uniqueNames
			.map(name => ({ name, count: (openCounts[name] || 0) + ((tagCount[name] || 0) - (openCounts[name] || 0)) }))
			.sort((a, b) => b.count - a.count);

		// 从已有配置中读取 known tags，新标签追加
		const { allTags: knownTags, siblings: knownSiblings } = parseTagTree();
		const knownSet = new Set(knownTags);

		const newTree = [];
		// 保留已有的顶级标签
		for (const name of knownSiblings) {
			if (candidates.some(c => c.name === name)) {
				newTree.push(name);
				knownSet.delete(name);
			}
		}
		// 推测新标签为顶级标签（用户后续可以手动调整缩进）
		for (const c of candidates) {
			if (!knownSet.has(c.name) && !newTree.includes(c.name)) {
				newTree.push(c.name);
			}
		}

		if (!newTree.length) {
			toastr?.info?.('扫描完成但未能推断标签层级。请手动调整缩进。');
			return;
		}

		settings.tagTree = newTree.join('\n');
		$(`#${extensionName}_tree`).val(settings.tagTree);
		saveSettingsDebounced();
		toastr?.success?.(`✅ 标签树已重建（${newTree.length} 个标签，从孤儿标签推断）`);
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

	// 找去重后的根级标签
	const allChildNamesDedup = new Set();
	for (const [name, meta] of Object.entries(tagMeta)) {
		for (const c of meta.children) allChildNamesDedup.add(c);
	}
	const rootNames = Object.keys(tagMeta).filter(n => !allChildNamesDedup.has(n));
	if (!rootNames.length) {
		// 回退：所有标签都是根级
		rootNames.push(...Object.keys(tagMeta));
	}

	// 按最早出现位置排序
	rootNames.sort((a, b) => (tagMeta[a]?.firstPos || 0) - (tagMeta[b]?.firstPos || 0));

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
			.sort((a, b) => (tagMeta[a]?.firstPos || 0) - (tagMeta[b]?.firstPos || 0));
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

// ========== 栈式算法修复标签（同级互斥、补开补闭）==========

function fixTagsInText(text) {
	const { allTags: tags, siblings } = parseTagTree();
	if (!tags.length) return { text, fixed: 0 };

	// 构建正则：匹配所有已配置标签的开/闭标签（排除自闭合）
	const escaped = tags.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
	const tagRe = new RegExp(`<\\/?(${escaped.join('|')})\\b[^>]*?(?<!\\/)>`, 'gi');

	const stack = [];       // [{ name }]
	const orphanCloses = []; // 孤立的闭合标签名
	const fixPoints = [];   // [{ name, pos }] 需要补闭的位置

	let m;
	while ((m = tagRe.exec(text)) !== null) {
		const full = m[0];
		const name = m[1];
		const pos = m.index;

		if (full.startsWith('</')) {
			// 闭合标签：从栈中找匹配的开标签并弹出
			let found = -1;
			for (let i = stack.length - 1; i >= 0; i--) {
				if (stack[i].name.toLowerCase() === name.toLowerCase()) { found = i; break; }
			}
			if (found >= 0) {
				// 找到了 → 弹出该标签及其以上的所有子标签
				//（子标签没被正常闭合说明 AI 掉了它们的闭合标签）
				while (stack.length > found) {
					const popped = stack.pop();
					if (popped.name.toLowerCase() !== name.toLowerCase()) {
						fixPoints.push({ name: popped.name, pos }); // 先补闭子标签
					}
				}
			} else {
				// 栈里没有 → 是孤儿闭标签（需要补开标签）
				orphanCloses.push(name);
			}
		} else {
			// 开标签
			if (siblings.has(name)) {
				// 是同级标签 → 闭合栈中所有已打开的同级标签（及其子标签）
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

	// 从后往前插入补闭标签（保持位置偏移不变）
	fixPoints.sort((a, b) => b.pos - a.pos);
	let body = text;
	let fixed = 0;

	for (const fp of fixPoints) {
		body = body.slice(0, fp.pos) + `</${fp.name}>\n` + body.slice(fp.pos);
		fixed++;
	}

	// 前置补开标签（孤儿闭标签）
	for (const tag of orphanCloses) {
		body = `<${tag}>\n` + body;
		fixed++;
	}

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

		// Step 1: 直接修改消息数据
		lastMsg.mes = result.text;

		// Step 2: 保存到磁盘
		if (ctx.saveChat) {
			await ctx.saveChat();
		} else {
			// 回退：手动触发保存
			console.warn('[TagAutoFixer] ctx.saveChat 不可用，尝试全局触发保存');
			if (window.SillyTavern?.getContext()?.saveChat) {
				await window.SillyTavern.getContext().saveChat();
			}
		}

		// Step 3: 即时渲染 —— 触发 CHARACTER_MESSAGE_RENDERED 事件让 Regex 美化生效
		let rendered = false;

		// 方案 A: 通过 eventSource 触发渲染事件（推荐）
		if (ctx.eventSource && ctx.eventTypes?.CHARACTER_MESSAGE_RENDERED) {
			ctx.eventSource.emit(ctx.eventTypes.CHARACTER_MESSAGE_RENDERED, lastIdx);
			rendered = true;
			console.log('[TagAutoFixer] 通过 eventSource 触发消息渲染');
		}

		// 方案 B: jQuery 全局事件
		if (!rendered) {
			try {
				$(window).trigger('character_message_rendered', [lastIdx]);
				rendered = true;
				console.log('[TagAutoFixer] 通过 jQuery 事件触发消息渲染');
			} catch (_) {}
		}

		// 方案 C: DOM 直接刷新（粗暴回退）
		if (!rendered) {
			const $mes = $('#chat .mes[mesid="' + lastIdx + '"]');
			if ($mes.length > 0) {
				const mesText = $mes.find('.mes_text');
				if (mesText.length > 0 && ctx.messageFormatting) {
					const ch_name = ctx.name2 || '';
					const formatted = ctx.messageFormatting(result.text, ch_name, false, false, lastIdx);
					mesText.html(formatted);
					rendered = true;
					console.log('[TagAutoFixer] 通过 DOM 直接刷新');
				}
			}
		}

		if (rendered) {
			toastr?.success?.(`✅ 已修复 ${result.fixed} 个标签`);
		} else {
			toastr?.success?.(`✅ 已修复 ${result.fixed} 个标签（可能需要重新加载聊天以查看效果）`);
		}

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
<button id="${extensionName}_scan" class="menu_button" style="flex:1;padding:6px;font-size:0.9em">🔍 扫描并重建标签树</button>
<button id="${extensionName}_btn" class="menu_button" style="flex:1;padding:6px;font-size:0.9em">🔧 修复最后一条消息</button>
</div>

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
	$(`#${extensionName}_scan`).on('click', scanAndFill);
	$(`#${extensionName}_btn`).on('click', async () => { await fixLastMessage(); });
});
