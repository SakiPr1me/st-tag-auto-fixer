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
NG_scene_guide
lts`;

const defaultSettings = { tagTree: defaultTagTree };
if (!extension_settings[extensionName]) extension_settings[extensionName] = defaultSettings;
const settings = extension_settings[extensionName];
if (!settings.tagTree) settings.tagTree = defaultTagTree;

// ====== 解析缩进树 ======
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

// ====== 扫描当前消息中的标签 ======
function scanAndFill() {
    const ctx = getContext();
    if (!ctx?.chat?.length) { toastr?.warning?.('没有聊天消息'); return; }

    let lastMsg = null;
    for (let i = ctx.chat.length - 1; i >= 0; i--) {
        if (!ctx.chat[i].is_user) { lastMsg = ctx.chat[i]; break; }
    }
    if (!lastMsg) { toastr?.warning?.('未找到AI消息'); return; }

    // 砍掉 HTML / XML Schema 块，避免误扫
    let clean = lastMsg.mes.replace(/<!DOCTYPE[\s\S]*?<\/html>/gi, '');
    clean = clean.replace(/<xs:schema[\s\S]*?<\/xs:schema>/gi, '');
    clean = clean.replace(/<dream_plot[\s\S]*?<\/dream_plot>/gi, '');
    clean = clean.replace(/<story_plot[\s\S]*?<\/story_plot>/gi, '');
    clean = clean.replace(/<output_format>[\s\S]*?<\/output_format>/gi, '');

    const tagPattern = /<\/?([a-zA-Z_][a-zA-Z0-9_.-]*)\b[^>]*>/g;
    const found = new Set();
    const noise = /^(html|head|body|meta|link|script|style|div|span|p|br|hr|img|a|h[1-6]|ul|ol|li|table|tr|td|th|input|button|form|label|select|option|textarea|iframe|svg|path|circle|rect|g|title|DOCTYPE|xml|xs:[a-z]+|dream_plot|dream_body|dream_after_format|story_plot|think|story_body|story_after_format|output_format)$/i;

    let m;
    while ((m = tagPattern.exec(clean)) !== null) {
        if (!noise.test(m[1])) found.add(m[1]);
    }

    if (found.size === 0) { toastr?.info?.('未检测到任何自定义标签'); return; }

    const existingNames = new Set(
        settings.tagTree.trim().split('\n').filter(l => l.trim()).map(l => l.trim())
    );

    let added = 0;
    for (const tag of found) {
        if (!existingNames.has(tag)) {
            settings.tagTree += '\n' + tag;
            added++;
        }
    }

    if (added === 0) { toastr?.info?.('没有发现新标签'); return; }
    $(`#${extensionName}_tree`).val(settings.tagTree);
    saveSettingsDebounced();
    toastr?.success?.(`已添加 ${added} 个新标签（平级），请手动调整缩进`);
}

// ====== 修复标签 ======
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

// ====== 酒馆上下文 ======
function getContext() {
    try { if (window.top?.SillyTavern?.getContext) return window.top.SillyTavern.getContext(); } catch (_) {}
    try { if (window.SillyTavern?.getContext) return window.SillyTavern.getContext(); } catch (_) {}
    return null;
}

// ====== 主修复函数 ======
function fixLastMessage() {
    const ctx = getContext();
    if (!ctx?.chat?.length) { toastr?.warning?.('没有聊天消息') || alert('没有聊天消息'); return ''; }

    let lastIdx = -1;
    for (let i = ctx.chat.length - 1; i >= 0; i--) {
        if (!ctx.chat[i].is_user) { lastIdx = i; break; }
    }
    if (lastIdx < 0) { toastr?.warning?.('未找到AI消息') || alert('未找到AI消息'); return ''; }

    const lastMsg = ctx.chat[lastIdx];
    const result = fixTagsInText(lastMsg.mes);

    if (result.fixed === 0) {
        toastr?.success?.('✅ 所有标签均已正确闭合') || alert('✅ 所有标签均已正确闭合');
        return '';
    }

    lastMsg.mes = result.text;

    // 保存
    try { ctx.saveChat?.(); } catch (_) {}
    try { ctx.forceSaveChat?.(); } catch (_) {}

    // 刷新渲染（走美化 Regex 链路，不需要刷页面）
    try {
        if (ctx.reloadMessage) {
            ctx.reloadMessage(lastIdx);
        } else if (ctx.renderMessage) {
            ctx.renderMessage(lastIdx);
        } else {
            ctx.reloadChat?.();
        }
    } catch (_) {
        try { window.triggerSlash?.('/reload-chat'); } catch (_) {}
    }

    toastr?.success?.(`✅ 已修复 ${result.fixed} 个标签`) || alert(`✅ 已修复 ${result.fixed} 个标签`);
    return '';
}

// ====== 入口注册 ======
jQuery(() => {
    // 入口1：斜杠命令
    const ctx = getContext();
    if (ctx?.SlashCommandParser) {
        try {
            ctx.SlashCommandParser.addCommand('fix-tags', fixLastMessage,
                ['fix-tags', '修复标签'],
                '自动修复AI输出中缺失的标签闭合（栈式算法）', true, true);
        } catch (_) {}
    }

    // 入口2：发送按钮旁的图标
    const btnId = `${extensionName}_send_btn`;
    const btn = `<div id="${btnId}" class="fa-solid fa-tag interactable" title="修复标签" style="cursor:pointer;padding:0 6px;font-size:1.05em;opacity:0.65"></div>`;
    const left = $('#leftSendForm'), right = $('#rightSendForm');
    const target = left.length ? left : (right.length ? right : null);
    if (target) { target.prepend(btn); $(`#${btnId}`).on('click', () => fixLastMessage()); }

    // 入口3：扩展面板
    const h = `
<div class="extension-settings" id="${extensionName}_s">
<div class="inline-drawer">
<div class="inline-drawer-toggle inline-drawer-header">
<b>Tag Auto Fixer</b>
<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
</div>
<div class="inline-drawer-content" style="display:none">

<p style="font-size:0.8em;color:var(--grey_color);margin-bottom:6px">
📌 缩进表示嵌套。不缩进的互为<b>同级</b>（遇到新同级自动闭合）。缩进的是父标签的<b>子标签</b>。
</p>

<textarea id="${extensionName}_tree" class="text_pole" style="width:100%;height:200px;font-family:monospace">${settings.tagTree}</textarea>

<div style="display:flex;gap:6px;margin-top:6px">
<button id="${extensionName}_scan" class="menu_button" style="flex:1;padding:6px;font-size:0.9em">🔍 扫描当前标签</button>
<button id="${extensionName}_btn" class="menu_button" style="flex:1;padding:6px;font-size:0.9em">🔧 修复标签</button>
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
    $(`#${extensionName}_btn`).on('click', () => fixLastMessage());
});
