import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "tag_auto_fixer";
const defaultTagList = "Advance\nchoice\ntodo\nremind\nsummary\nNG_scene\nscene\nDanmaku\nEvents\nNG_scene_guide\ncontent";

const defaultSettings = { tagList: defaultTagList };
if (!extension_settings[extensionName]) extension_settings[extensionName] = defaultSettings;
const settings = extension_settings[extensionName];
if (!settings.tagList) settings.tagList = defaultTagList;

function getTagNames() {
    return settings.tagList.split('\n').map(t => t.trim()).filter(t => t);
}

function fixTagsInText(text) {
    const tags = getTagNames();
    if (!tags.length) return { text, fixed: 0 };

    const escaped = tags.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const tagRe = new RegExp(`<\\/?(${escaped.join('|')})\\b[^>]*>`, 'gi');

    const stack = [];
    const orphanCloses = [];

    let m;
    while ((m = tagRe.exec(text)) !== null) {
        const full = m[0];
        const name = m[1];
        if (full.startsWith('</')) {
            let found = -1;
            for (let i = stack.length - 1; i >= 0; i--) {
                if (stack[i].name.toLowerCase() === name.toLowerCase()) { found = i; break; }
            }
            if (found >= 0) stack.splice(found, 1);
            else orphanCloses.push(name);
        } else {
            stack.push({ name });
        }
    }

    let body = text;
    let fixed = 0;

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
    if (!ctx || !ctx.chat) { toastr?.warning?.('无法访问酒馆上下文') || alert('无法访问酒馆上下文'); return ''; }
    const chat = ctx.chat;
    if (!chat.length) { toastr?.warning?.('当前没有聊天消息') || alert('当前没有聊天消息'); return ''; }

    let lastMsg = null;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!chat[i].is_user) { lastMsg = chat[i]; break; }
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

// ====== 入口1：斜杠命令 /fix-tags ======
jQuery(() => {
    const ctx = getContext();
    if (ctx?.SlashCommandParser) {
        try {
            ctx.SlashCommandParser.addCommand(
                'fix-tags',
                fixLastMessage,
                ['fix-tags', '修复标签'],
                '自动修复AI输出中缺失的标签闭合（栈式算法，支持嵌套）',
                true,
                true
            );
        } catch (_) {}
    }
});

// ====== 入口2：发送按钮旁挂图标 ======
jQuery(() => {
    const btnId = `${extensionName}_send_btn`;
    const btn = `<div id="${btnId}" class="fa-solid fa-tag interactable" title="修复标签" style="cursor:pointer;padding:0 6px;font-size:1.05em;opacity:0.65"></div>`;
    const left = $('#leftSendForm');
    const right = $('#rightSendForm');
    const target = left.length ? left : (right.length ? right : null);
    if (target) {
        target.prepend(btn);
        $(`#${btnId}`).on('click', () => fixLastMessage());
    }
});

// ====== 入口3：扩展面板 ======
jQuery(() => {
    const h = `
<div class="extension-settings" id="${extensionName}_s">
<div class="inline-drawer">
<div class="inline-drawer-toggle inline-drawer-header">
<b>Tag Auto Fixer</b>
<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
</div>
<div class="inline-drawer-content" style="display:none">

<label style="font-size:0.85em;color:var(--grey_color)">标签名（一行一个，不含尖括号）：</label>
<textarea id="${extensionName}_tl" class="text_pole" style="width:100%;height:100px;font-family:monospace">${settings.tagList}</textarea>

<button id="${extensionName}_btn" class="menu_button" style="width:100%;margin-top:8px;padding:10px;font-size:1.05em">
🔧 修复最后一条消息的标签
</button>

<p style="margin-top:6px;font-size:0.8em;color:var(--grey_color)">
也可用斜杠命令 <code>/fix-tags</code> 或点发送按钮旁 🏷️ 图标
</p>

</div></div></div>`;

    $('#extensions_settings').append(h);

    $(`#${extensionName}_tl`).on('input', function() {
        settings.tagList = $(this).val();
        saveSettingsDebounced();
    });

    $(`#${extensionName}_btn`).on('click', () => fixLastMessage());
});
