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

function scanAndFill() {
    const ctx = getContext();
    if (!ctx?.chat?.length) { toastr?.warning?.('没有聊天消息'); return; }

    let lastMsg = null;
    for (let i = ctx.chat.length - 1; i >= 0; i--) {
        if (!ctx.chat[i].is_user) { lastMsg = ctx.chat[i]; break; }
    }
    if (!lastMsg) { toastr?.warning?.('未找到AI消息'); return; }

    let clean = lastMsg.mes.replace(/<!DOCTYPE[\s\S]*?<\/html>/gi, '');
    clean = clean.replace(/<xs:schema[\s\S]*?<\/xs:schema>/gi, '');
    clean = clean.replace(/<dream_plot[\s\S]*?<\/dream_plot>/gi, '');
    clean = clean.replace(/<story_plot[\s\S]*?<\/story_plot>/gi, '');
    clean = clean.replace(/<output_format>[\s\S]*?<\/output_format>/gi, '');

    const tagRe = /<\/?([a-zA-Z_][a-zA-Z0-9_.-]*)\b[^>]*>/g;
    const allTags = [];
    const tagCount = {};

    let m;
    while ((m = tagRe.exec(clean)) !== null) {
        const name = m[1];
        allTags.push({ name, isClose: m[0].startsWith('</'), pos: m.index });
        tagCount[name] = (tagCount[name] || 0) + 1;
    }

    if (!allTags.length) { toastr?.info?.('未检测到任何标签'); return; }

    const ranges = [];
    const openStack = [];
    for (const t of allTags) {
        if (!t.isClose) {
            openStack.push({ name: t.name, start: t.pos });
        } else {
            for (let i = openStack.length - 1; i >= 0; i--) {
                if (openStack[i].name === t.name) {
                    ranges.push({ name: t.name, start: openStack[i].start, end: t.pos, children: new Set() });
                    openStack.splice(i, 1);
                    break;
                }
            }
        }
    }
    if (!ranges.length) { toastr?.info?.('未检测到任何闭合标签对'); return; }

    for (const parent of ranges) {
        for (const child of ranges) {
            if (child.name !== parent.name && child.start > parent.start && child.end < parent.end) {
                parent.children.add(child.name);
            }
        }
    }

    const hasChildren = new Set();
    for (const r of ranges) { if (r.children.size > 0) hasChildren.add(r.name); }
    const kept = new Set();
    for (const r of ranges) {
        const count = tagCount[r.name] / 2;
        if (hasChildren.has(r.name) || count <= 1) kept.add(r.name);
    }

    const allChildNames = new Set();
    for (const r of ranges) {
        if (kept.has(r.name)) {
            for (const c of r.children) { if (kept.has(c)) allChildNames.add(c); }
        }
    }
    const rootCandidates = ranges.filter(r => kept.has(r.name) && !allChildNames.has(r.name));

    const builtTree = [];
    function addBranch(tag, depth) {
        const prefix = '  '.repeat(depth);
        builtTree.push(prefix + tag.name);
        for (const childName of tag.children) {
            if (!kept.has(childName)) continue;
            const childRange = ranges.find(r => r.name === childName);
            if (childRange) addBranch(childRange, depth + 1);
        }
    }
    for (const root of rootCandidates) { addBranch(root, 0); }

    if (!builtTree.length) { toastr?.info?.('无法推断标签结构'); return; }

    const newTree = builtTree.join('\n');
    settings.tagTree = newTree;
    $(`#${extensionName}_tree`).val(settings.tagTree);
    saveSettingsDebounced();

    const totalNames = new Set(ranges.map(r => r.name));
    toastr?.success?.(`✅ 标签树已重建（${kept.size} 个结构标签，${totalNames.size - kept.size} 个内联标签已过滤）`);
}

function fixTagsInText(text) {
    const { allTags: tags, siblings } = parseTagTree();
    if (!tags.length) return { text, fixed: 0 };

    const escaped = tags.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const tagRe = new RegExp(`<\\/?(${escaped.join('|')})\\b[^>]*>`, 'gi');

    const stack = [];
    const orphanCloses = [];
    const fixPoints = [];

    let m;
    while ((m = tagRe.exec(text)) !== null) {
        const full = m[0];
        const name = m[1];
        const pos = m.index;

        if (full.startsWith('</')) {
            let found = -1;
            for (let i = stack.length - 1; i >= 0; i--) {
                if (stack[i].name.toLowerCase() === name.toLowerCase()) { found = i; break; }
            }
            if (found >= 0) stack.splice(found, 1);
            else orphanCloses.push(name);
        } else {
            if (siblings.has(name)) {
                for (let i = stack.length - 1; i >= 0; i--) {
                    if (siblings.has(stack[i].name) && stack[i].name !== name) {
                        fixPoints.push({ name: stack[i].name, pos });
                        stack.splice(i, 1);
                        break;
                    }
                }
            }
            stack.push({ name });
        }
    }

    fixPoints.sort((a, b) => b.pos - a.pos);
    let body = text;
    let fixed = 0;

    for (const fp of fixPoints) {
        body = body.slice(0, fp.pos) + `</${fp.name}>\n` + body.slice(fp.pos);
        fixed++;
    }

    for (const tag of orphanCloses) {
        body = `<${tag}>\n` + body;
        fixed++;
    }

    while (stack.length > 0) {
        body += `</${stack.pop().name}>\n`;
        fixed++;
    }

    return { text: body, fixed };
}

function getContext() {
    try { if (window.top?.SillyTavern?.getContext) return window.top.SillyTavern.getContext(); } catch (_) {}
    try { if (window.SillyTavern?.getContext) return window.SillyTavern.getContext(); } catch (_) {}
    return null;
}

async function fixLastMessage() {
    const ctx = getContext();
    if (!ctx?.chat?.length) { toastr?.warning?.('没有聊天消息'); return; }

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

    lastMsg.mes = result.text;
    await ctx.saveChat?.();

    try {
        SillyTavern.refreshChat();
    } catch (_) {
        window.location.reload();
    }

    toastr?.success?.(`✅ 已修复 ${result.fixed} 个标签`);
}

jQuery(async () => {
    const ctx = getContext();

    if (ctx?.SlashCommandParser) {
        try {
            ctx.SlashCommandParser.addCommand('fix-tags', fixLastMessage,
                ['fix-tags', '修复标签'],
                '自动修复AI输出中缺失的标签闭合', true, true);
        } catch (_) {}
    }

    const btnId = `${extensionName}_send_btn`;
    const btn = `<div id="${btnId}" class="fa-solid fa-tag interactable" title="修复标签" style="cursor:pointer;padding:0 6px;font-size:1.05em;opacity:0.65"></div>`;
    const left = $('#leftSendForm'), right = $('#rightSendForm');
    const target = left.length ? left : (right.length ? right : null);
    if (target) { target.prepend(btn); $(`#${btnId}`).on('click', async () => { await fixLastMessage(); }); }

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

    $(`#${extensionName}_tree`).on('input', function() {
        settings.tagTree = $(this).val();
        saveSettingsDebounced();
    });

    $(`#${extensionName}_scan`).on('click', scanAndFill);
    $(`#${extensionName}_btn`).on('click', async () => { await fixLastMessage(); });
});
