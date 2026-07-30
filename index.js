import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "tag_auto_fixer";
const defaultTagTree = `Advance
  choice
  todo
  remind
Events
summary
scene
content
Danmaku
NG_scene
NG_scene_guide
extra`;

const defaultSettings = { tagTree: defaultTagTree };
if (!extension_settings[extensionName]) extension_settings[extensionName] = defaultSettings;
const settings = extension_settings[extensionName];
if (!settings.tagTree) settings.tagTree = defaultTagTree;

// 解析缩进树 → { allTags: 所有标签名, siblings: 根级标签名集合 }
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

// 扫描最后一条AI消息，提取所有标签并填充树
function scanAndFill() {
    const ctx = getContext();
    if (!ctx?.chat?.length) { toastr?.warning?.('没有聊天消息'); return; }

    let lastMsg = null;
    for (let i = ctx.chat.length - 1; i >= 0; i--) {
        if (!ctx.chat[i].is_user) { lastMsg = ctx.chat[i]; break; }
    }
    if (!lastMsg) { toastr?.warning?.('未找到AI消息'); return; }

    const tagPattern = /<\/?([a-zA-Z_][a-zA-Z0-9_.-]*)\b[^>]*>/g;
    const found = new Set();
    let m;
    while ((m = tagPattern.exec(lastMsg.mes)) !== null) {
        found.add(m[1]);
    }

    if (found.size === 0) { toastr?.info?.('未检测到任何标签'); return; }

    // 保留已存在的缩进结构，新增的放在末尾
    settings.tagTree = settings.tagTree.trim() + '\n' + [...found].join('\n');
    $(`#${extensionName}_tree`).val(settings.tagTree);
    saveSettingsDebounced();
    toastr?.success?.(`已扫描到 ${found.size} 个标签`);
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
            if (found >= 0) {
                stack.splice(found, 1);
            } else {
                orphanCloses.push(name);
            }
        } else {
            // 同级标签：遇到新的同级，自动关掉上一个未闭合的同级
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

function fixLastMessage() {
    const ctx = getContext();
    if (!ctx?.chat?.length) { toastr?.warning?.('没有聊天消息') || alert('没有聊天消息'); return ''; }

    let lastMsg = null;
    for (let i = ctx.chat.length - 1; i >= 0; i--) {
        if (!ctx.chat[i].is_user) { lastMsg = ctx.chat[i]; break; }
    }
    if (!lastMsg) { toastr?.warning?.('未找到AI消息') || alert('未找到AI消息'); return ''; }

    const result = fixTagsInText(lastMsg.mes);
    if (result.fixed === 0) {
        toastr?.success?.('✅ 所有标签均已正确闭合') || alert('✅ 所有标签均已正确闭合');
        return '';
    }

    lastMsg.mes = result.text;
    try { ctx.saveChat?.(); } catch (_) { try { window.triggerSaveChat?.(); } catch (_) {} }
    try { ctx.reloadChat?.(); } catch (_) { try { window.triggerSlash?.('/reload-chat'); } catch (_) {} }

    toastr?.success?.(`✅ 已修复 ${result.fixed} 个标签`) || alert(`✅ 已修复 ${result.fixed} 个标签`);
    return '';
}

jQuery(() => {
    const ctx = getContext();
    if (ctx?.SlashCommandParser) {
        try {
            ctx.SlashCommandParser.addCommand('fix-tags', fixLastMessage, ['fix-tags', '修复标签'],
                '自动修复AI输出中缺失的标签闭合', true, true);
        } catch (_) {}
    }

    const btnId = `${extensionName}_send_btn`;
    const btn = `<div id="${btnId}" class="fa-solid fa-tag interactable" title="修复标签" style="cursor:pointer;padding:0 6px;font-size:1.05em;opacity:0.65"></div>`;
    const left = $('#leftSendForm'), right = $('#rightSendForm');
    const target = left.length ? left : (right.length ? right : null);
    if (target) { target.prepend(btn); $(`#${btnId}`).on('click', () => fixLastMessage()); }

    const h = `
<div class="extension-settings" id="${extensionName}_s">
<div class="inline-drawer">
<div class="inline-drawer-toggle inline-drawer-header">
<b>Tag Auto Fixer</b>
<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
</div>
<div class="inline-drawer-content" style="display:none">

<p style="font-size:0.8em;color:var(--grey_color);margin-bottom:6px">
📌 <b>规则：</b>缩进表示嵌套。不缩进的互为<b>同级</b>（遇到新同级会自动闭合）。缩进的是父标签的<b>子标签</b>。
</p>

<textarea id="${extensionName}_tree" class="text_pole" style="width:100%;height:180px;font-family:monospace">${settings.tagTree}</textarea>

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
