import { secret_state, SECRET_KEYS } from '../../../secrets.js';
import { promptManager } from '../../../openai.js';
import { copyText, getBase64Async, getFileExtension, saveBase64AsFile } from '../../../utils.js';
import { DOMPurify, showdown, hljs } from '../../../../lib.js';

const markdown = new showdown.Converter({
    tables: true,
    strikethrough: true,
    simpleLineBreaks: true,
    literalMidWordUnderscores: true,
    disableForced4SpacesIndentedSublists: true,
    openLinksInNewWindow: true,
});

const MODULE = 'sidekick';

const DEFAULT_SYSTEM_PROMPT = `You are Sidekick, an out-of-character assistant sitting beside {{user}} while they roleplay with {{char}}. You can see the roleplay context below.
Chat casually and helpfully about the story: answer questions about details, keep track of facts, suggest ideas, and point out inconsistencies. Stay out of character unless asked.`;

const DEFAULT_NAME_PROMPT = 'Write a short title (2 to 6 words) for the conversation below, based on its main topic. Reply with the title only: no quotes, no trailing punctuation.';

const DEFAULTS = {
    enabled: true,
    profileId: '',
    maxTokens: 8192,
    stream: true,
    showThinking: true,
    historyDepth: 30,
    include: {
        description: true,
        personality: true,
        scenario: true,
        examples: false,
        persona: true,
        worldInfo: false,
        systemPrompts: false,
        chat: true,
    },
    includeHidden: false,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    autoName: true,
    nameProfileId: '',
    nameModel: '',
    namePrompt: DEFAULT_NAME_PROMPT,
    collapsed: true,
    // put it in the bottom right corner by default
    windowPos: null,
    iconPos: null,
    windowPosMobile: null,
    iconPosMobile: null,
};

const INCLUDE_LABELS = {
    description: 'Character description',
    personality: 'Character personality',
    scenario: 'Scenario',
    examples: 'Example dialogue',
    persona: 'User persona',
    worldInfo: 'World info (active entries)',
    systemPrompts: 'SillyTavern system prompts',
    chat: 'Chat history',
};

const PRESET_KEYS = ['profileId', 'maxTokens', 'stream', 'showThinking', 'historyDepth', 'include', 'includeHidden', 'systemPrompt', 'autoName', 'nameProfileId', 'nameModel', 'namePrompt'];
const pickPreset = source => structuredClone(Object.fromEntries(PRESET_KEYS.map(key => [key, source[key]])));

const ctx = () => SillyTavern.getContext();
const isChatCompletionProfile = profile => ctx().CONNECT_API_MAP[profile?.api]?.selected === 'openai';
let settings;
let abortController = null;
let live = null;
let pendingAttachments = [];
let uploading = 0;
const imageCache = new Map();
const naming = new Set();
const openThoughts = new Set();
let liveFrame = 0;
let editing = null;
let view = 'chat';
let historyQuery = '';
let selecting = false;
const selected = new Set();
let temp = null;

function loadSettings() {
    const all = ctx().extensionSettings;
    all[MODULE] = Object.assign(structuredClone(DEFAULTS), all[MODULE]);
    all[MODULE].include = Object.assign({ ...DEFAULTS.include }, all[MODULE].include);
    for (const key of ['editTool', 'editMode', 'editPrompt', 'autoApplyEdits']) delete all[MODULE][key];
    if (!all[MODULE].maxTokensBumped) {
        if (all[MODULE].maxTokens === 1024) all[MODULE].maxTokens = DEFAULTS.maxTokens;
        all[MODULE].maxTokensBumped = true;
    }
    settings = all[MODULE];
    // always start minimized
    settings.collapsed = true;
    if (!Array.isArray(settings.presets) || !settings.presets.length) {
        settings.presets = [{ id: ctx().uuidv4(), name: 'Default', values: pickPreset(settings) }];
    }
    loadPresetValues(settings.presets.find(p => p.id === settings.presetId) ?? settings.presets[0]);
}

function loadPresetValues(preset) {
    settings.presetId = preset.id;
    Object.assign(settings, pickPreset(DEFAULTS), structuredClone(preset.values));
    settings.include = { ...DEFAULTS.include, ...preset.values.include };
}

const activePreset = () => settings.presets.find(p => p.id === settings.presetId);

const save = () => {
    const preset = activePreset();
    if (preset) preset.values = pickPreset(settings);
    ctx().saveSettingsDebounced();
    scheduleEstimate();
};
const saveMeta = () => ctx().saveMetadataDebounced();

function getStore() {
    const meta = ctx().chatMetadata;
    let store = meta[MODULE];
    if (Array.isArray(store)) {
        store = { activeId: null, sessions: [] };
        if (meta[MODULE].length) {
            const migrated = createSession(meta[MODULE]);
            store.sessions.push(migrated);
            store.activeId = migrated.id;
        }
    }
    if (!store || !Array.isArray(store.sessions)) store = { activeId: null, sessions: [] };
    meta[MODULE] = store;
    return store;
}

function createSession(messages = []) {
    const now = Date.now();
    return { id: ctx().uuidv4(), title: '', created: now, updated: now, messages };
}

function getActive() {
    if (temp) return temp;
    const store = getStore();
    return store.sessions.find(s => s.id === store.activeId) ?? null;
}

function firstMessageTitle(session) {
    const firstMessage = session.messages.find(m => m.role === 'user');
    const first = firstMessage?.content || firstMessage?.attachments?.[0]?.name || '';
    const line = first.split('\n')[0].trim();
    return line.length > 48 ? line.slice(0, 47) + '…' : line;
}

function sessionTitle(session) {
    if (!session) return 'New conversation';
    return session.title || firstMessageTitle(session) || 'Untitled';
}

function leaveTemp() {
    if (!temp) return;
    if (live?.sessionId === temp.id) abortController?.abort();
    temp = null;
}

function toggleTemp() {
    if (temp) leaveTemp();
    else temp = createSession();
    editing = null;
    view = 'chat';
    renderAll();
    $('#sidekick_input').trigger('focus');
}

function openSession(id) {
    leaveTemp();
    getStore().activeId = id;
    editing = null;
    saveMeta();
    view = 'chat';
    renderAll();
    $('#sidekick_input').trigger('focus');
}

function newConversation() {
    leaveTemp();
    getStore().activeId = null;
    editing = null;
    saveMeta();
    view = 'chat';
    renderAll();
    $('#sidekick_input').trigger('focus');
}

async function deleteSessions(sessions) {
    if (!sessions.length) return false;
    const c = ctx();
    const what = sessions.length === 1
        ? $('<b>').text(sessionTitle(sessions[0])).prop('outerHTML')
        : `<b>${sessions.length} conversations</b>`;
    const ok = await c.callGenericPopup(`Delete ${what}? This can't be undone.`, c.POPUP_TYPE.CONFIRM, '', { okButton: 'Delete' });
    if (!ok) return false;
    const store = getStore();
    const ids = new Set(sessions.map(s => s.id));
    store.sessions = store.sessions.filter(s => !ids.has(s.id));
    if (ids.has(store.activeId)) {
        store.activeId = [...store.sessions].sort((a, b) => b.updated - a.updated)[0]?.id ?? null;
        editing = null;
    }
    ids.forEach(id => selected.delete(id));
    saveMeta();
    renderAll();
    return true;
}

function setSelecting(on) {
    selecting = on;
    selected.clear();
    renderHistory();
}

function startRename(el, session) {
    const input = $('<input type="text" class="text_pole sidekick_rename sidekick_nodrag" maxlength="80">')
        .val(sessionTitle(session))
        .attr('aria-label', 'Conversation name');
    let done = false;
    const finish = (commit) => {
        if (done) return;
        done = true;
        if (commit) {
            session.title = String(input.val()).trim();
            saveMeta();
        }
        renderAll();
    };
    input.on('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
    });
    input.on('blur', () => finish(true));
    input.on('click pointerdown', e => e.stopPropagation());
    $(el).replaceWith(input);
    input.trigger('focus').trigger('select');
}

function getStSystemPrompts(card) {
    const c = ctx();
    const sub = (text, original = '') => c.substituteParams(text ?? '', { original }).trim();

    if (c.mainApi === 'openai') {
        if (!promptManager) return [];
        return promptManager.getPromptsForCharacter(promptManager.activeCharacter, true)
            .filter(p => !p.marker)
            .map((p) => {
                let content = sub(p.content);
                if (p.identifier === 'main' && card.system) content = sub(card.system, content);
                if (p.identifier === 'jailbreak' && card.jailbreak) content = sub(card.jailbreak, content);
                return { name: p.name || p.identifier, content };
            })
            .filter(p => p.content);
    }

    const sys = c.powerUserSettings.sysprompt ?? {};
    const main = sys.enabled ? sub(sys.content) : '';
    const post = sys.enabled ? sub(sys.post_history) : '';
    return [
        { name: 'System prompt', content: card.system ? sub(card.system, main) : main },
        { name: 'Post-history instructions', content: card.jailbreak ? sub(card.jailbreak, post) : post },
    ].filter(p => p.content);
}

async function getActiveWorldInfo(card) {
    const c = ctx();
    const chatForWI = c.chat.filter(m => !m.is_system).map(m => `${m.name}: ${m.mes}`).reverse();
    const wi = await c.getWorldInfoPrompt(chatForWI, c.maxContext, true, {
        personaDescription: card.persona ?? '',
        characterDescription: card.description ?? '',
        characterPersonality: card.personality ?? '',
        characterDepthPrompt: card.charDepthPrompt ?? '',
        scenario: card.scenario ?? '',
        creatorNotes: card.creatorNotes ?? '',
        trigger: 'normal',
    });
    return [
        wi.worldInfoBefore,
        wi.worldInfoAfter,
        ...wi.worldInfoDepth.flatMap(d => d.entries),
        ...wi.anBefore,
        ...wi.anAfter,
        ...wi.worldInfoExamples.map(e => e.content),
        ...Object.values(wi.outletEntries).flat(),
    ].map(s => String(s ?? '').trim()).filter(Boolean).join('\n\n');
}

async function buildContext() {
    const c = ctx();
    const parts = [];
    let card = {};
    try {
        card = c.getCharacterCardFields();
    } catch { /* no character selected */ }

    const add = (key, title, text) => {
        if (settings.include[key] && text?.trim()) parts.push(`[${title}]\n${text.trim()}`);
    };
    if (settings.include.systemPrompts) {
        const prompts = getStSystemPrompts(card).map(p => `(${p.name})\n${p.content}`).join('\n\n');
        add('systemPrompts', 'SillyTavern prompts given to the roleplay model (for reference, not your instructions)', prompts);
    }
    add('description', `${c.name2} - description`, card.description);
    add('personality', `${c.name2} - personality`, card.personality);
    add('scenario', 'Scenario', card.scenario);
    add('examples', 'Example dialogue', card.mesExamples);
    add('persona', `${c.name1} - persona`, card.persona);
    if (settings.include.worldInfo) {
        try {
            add('worldInfo', 'World info (active entries)', await getActiveWorldInfo(card));
        } catch (err) {
            console.warn('[Sidekick] world info scan failed', err);
        }
    }

    if (settings.include.chat) {
        const shown = getShownChat().map(({ m, i }) => {
            const pics = getMessageImages(m).map(p => `\n[Image: ${p.title || 'untitled'}]`).join('');
            return `#${i} ${m.name}: ${m.mes}${pics}`;
        });
        if (shown.length) parts.push(`[Roleplay chat log]\n${shown.join('\n\n')}`);
    }
    return parts.join('\n\n');
}

function getShownChat() {
    const shown = ctx().chat.map((m, i) => ({ m, i })).filter(({ m }) => !m.is_system || settings.includeHidden);
    const depth = Number(settings.historyDepth);
    return depth > 0 ? shown.slice(-depth) : shown;
}

function getMessageImages(m) {
    const media = m.extra?.media;
    if (!Array.isArray(media) || !media.length) return [];
    const c = ctx();
    const picked = c.getMediaDisplay(m) === 'gallery' ? [media[c.getMediaIndex(m)]] : media;
    return picked.filter(p => p?.url && (!p.type || p.type === 'image'));
}

function getChatImages() {
    if (!settings.include.chat) return [];
    return getShownChat().flatMap(({ m, i }) => getMessageImages(m).map(p => ({ ...p, label: `#${i} ${m.name}` })));
}

async function chatImagesMessage() {
    const pics = getChatImages();
    if (!pics.length) return null;
    const detail = ctx().chatCompletionSettings.inline_image_quality || 'auto';
    const parts = [{ type: 'text', text: '[Images attached to messages in the roleplay chat]' }];
    for (const p of pics) {
        parts.push({ type: 'text', text: `${p.label}${p.title ? ` (${p.title})` : ''}:` });
        try {
            parts.push({ type: 'image_url', image_url: { url: await loadImageData(p.url), detail } });
        } catch (err) {
            console.warn('[Sidekick] could not load chat image', p.url, err);
            parts.push({ type: 'text', text: '[Image could not be loaded]' });
        }
    }
    return { role: 'user', content: parts };
}

async function buildMessages(session, images) {
    const c = ctx();
    let system = c.substituteParams(settings.systemPrompt);
    const context = await buildContext();
    if (context) system += '\n\n' + context;

    const messages = [{ role: 'system', content: system }];
    // ST's "Send inline media" toggle
    const chatImages = images && c.chatCompletionSettings.media_inlining ? await chatImagesMessage() : null;
    if (chatImages) messages.push(chatImages);
    for (const m of session.messages) {
        if (m.role === 'assistant' && !m.content) continue;
        messages.push({ role: m.role, content: m.attachments?.length ? await withAttachments(m.content, m.attachments, images) : m.content });
    }
    return messages;
}

async function withAttachments(text, attachments, images) {
    let body = text;
    for (const a of attachments.filter(a => a.type === 'text')) {
        body += `\n\n[Attached file: ${a.name}]\n\`\`\`\n${a.text}\n\`\`\``;
    }
    const pics = attachments.filter(a => a.type === 'image');
    if (!pics.length) return body;
    if (!images) return body + pics.map(a => `\n[Image attached: ${a.name}. This model can't see images.]`).join('');

    const detail = ctx().chatCompletionSettings.inline_image_quality || 'auto';
    const parts = body ? [{ type: 'text', text: body }] : [];
    for (const a of pics) {
        try {
            parts.push({ type: 'image_url', image_url: { url: await loadImageData(a.url), detail } });
        } catch (err) {
            console.warn('[Sidekick] could not load attachment', a.url, err);
            parts.push({ type: 'text', text: `[Image ${a.name} could not be loaded]` });
        }
    }
    return parts;
}

async function loadImageData(url) {
    if (!imageCache.has(url)) {
        const response = await fetch(url, { cache: 'force-cache' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        imageCache.set(url, await getBase64Async(await response.blob()));
    }
    return imageCache.get(url);
}

const TEXT_EXTENSIONS = ['txt', 'md', 'json', 'csv', 'yaml', 'yml', 'log', 'xml', 'html', 'js', 'py'];
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_IMAGE_SIDE = 2048;

// shrink big images
async function prepareImage(file) {
    const dataUrl = await getBase64Async(file);
    const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    if (file.type === 'image/gif') return { base64: dataUrl.split(',')[1], ext };

    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    // the upload endpoint only takes common formats. get re-encoded below
    if (scale === 1 && ['png', 'jpg', 'webp'].includes(ext)) return { base64: dataUrl.split(',')[1], ext };

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    // keep png for transparency, everything else becomes jpeg
    const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    return { base64: canvas.toDataURL(type, 0.9).split(',')[1], ext: type === 'image/png' ? 'png' : 'jpg' };
}

async function addFiles(files) {
    for (const file of files) {
        const ext = getFileExtension(file);
        if (file.type.startsWith('image/')) {
            uploading++;
            renderAttachments();
            try {
                const { base64, ext: outExt } = await prepareImage(file);
                const url = await saveBase64AsFile(base64, 'Sidekick', `sidekick_${Date.now()}`, outExt);
                pendingAttachments.push({ type: 'image', url, name: file.name });
            } catch (err) {
                console.error('[Sidekick] image upload failed', err);
                toastr.error(`Couldn't attach ${file.name}: ${err.message}`, 'Sidekick');
            } finally {
                uploading--;
            }
        } else if (file.type.startsWith('text/') || TEXT_EXTENSIONS.includes(ext)) {
            if (file.size > MAX_TEXT_BYTES) {
                toastr.warning(`${file.name} is over 256 KB. Attach a smaller file.`, 'Sidekick');
                continue;
            }
            pendingAttachments.push({ type: 'text', name: file.name, text: await file.text() });
        } else {
            toastr.warning(`${file.name} isn't an image or text file.`, 'Sidekick');
        }
        renderAttachments();
    }
    renderAttachments();
}

function renderAttachments() {
    const box = $('#sidekick_attachments').empty();
    pendingAttachments.forEach((a, i) => {
        const chip = $('<div class="sidekick_chip">').attr('title', a.name);
        if (a.type === 'image') chip.append($('<img alt="">').attr('src', a.url));
        else chip.append($('<i class="fa-solid fa-file-lines"></i>'), $('<span>').text(a.name));
        const remove = $('<i class="fa-solid fa-xmark sidekick_chip_remove" role="button" tabindex="0">')
            .attr('title', `Remove ${a.name}`)
            .on('click keydown', (e) => {
                if (e.type === 'keydown' && e.key !== 'Enter') return;
                pendingAttachments.splice(i, 1);
                renderAttachments();
            });
        box.append(chip.append(remove));
    });
    if (uploading > 0) box.append('<div class="sidekick_chip"><i class="fa-solid fa-spinner fa-spin"></i><span>Uploading…</span></div>');
    box.toggleClass('open', box.children().length > 0);
    updateSendState();
}

function renderMessageAttachments(attachments) {
    const wrap = $('<div class="sidekick_msg_attachments">');
    for (const a of attachments) {
        if (a.type === 'image') {
            wrap.append($('<a target="_blank" rel="noopener">').attr({ href: a.url, title: a.name })
                .append($('<img class="sidekick_thumb" alt="">').attr('src', a.url)));
        } else {
            wrap.append($('<div class="sidekick_chip">').attr('title', a.name)
                .append($('<i class="fa-solid fa-file-lines"></i>'), $('<span>').text(a.name)));
        }
    }
    return wrap;
}

// empty profileId = follow whatever Connection Manager has selected
function chatProfileId() {
    return settings.profileId || ctx().extensionSettings.connectionManager?.selectedProfile;
}

// pulls inline thinking out of the reply
// reasoning the API sends separately isn't in the text; callers merge it in
function splitThinking(text) {
    let t = String(text ?? '');
    const found = [];
    try {
        const parsed = ctx().parseReasoningFromString(t, { strict: false });
        if (parsed?.reasoning) {
            found.push(parsed.reasoning);
            t = parsed.content;
        }
    } catch { /* no reasoning template configured */ }
    t = t.replace(/<(think|thinking|reasoning)>([\s\S]*?)<\/\1>/gi, (_, _tag, inner) => {
        found.push(inner.trim());
        return '';
    });
    t = t.replace(/<(think|thinking|reasoning)>([\s\S]*)$/i, (_, _tag, inner) => {
        found.push(inner.trim());
        return '';
    });
    return { content: t.trim(), reasoning: found.filter(Boolean).join('\n\n') };
}

const stripThinking = text => splitThinking(text).content;
const joinReasoning = (...parts) => parts.map(p => String(p ?? '').trim()).filter(Boolean).join('\n\n');

function cleanTitle(raw) {
    const line = stripThinking(raw).split('\n').map(l => l.trim()).find(Boolean) ?? '';
    return line
        .replace(/^title\s*:\s*/i, '')
        .replace(/^["'*#\s]+|["'*\s]+$/g, '')
        .replace(/\.$/, '')
        .slice(0, 60)
        .trim();
}

function useFallbackTitle(session) {
    if (session.title) return;
    session.title = firstMessageTitle(session);
    saveMeta();
}

async function generateTitle(session, manual = false) {
    const profileId = settings.nameProfileId || chatProfileId();
    if (!profileId || naming.has(session.id)) {
        if (manual && !profileId) toastr.warning('No connection profile is selected.');
        return;
    }
    const transcript = session.messages.slice(0, 6)
        .map(m => `${m.role === 'user' ? 'User' : 'Sidekick'}: ${m.content.slice(0, 600)}`)
        .join('\n\n');
    if (!transcript) return;

    naming.add(session.id);
    renderHistory();
    try {
        const svc = ctx().ConnectionManagerRequestService;
        const overrides = getProviderOverrides(svc.getProfile(profileId));
        if (settings.nameModel.trim()) overrides.model = settings.nameModel.trim();
        const prompt = svc.constructPrompt([
            { role: 'system', content: ctx().substituteParams(settings.namePrompt) },
            { role: 'user', content: transcript },
        ], profileId);
        const result = await svc.sendRequest(profileId, prompt, undefined, { stream: false }, overrides);
        const title = cleanTitle(result?.content);
        if (title && (manual || !session.title)) {
            session.title = title;
            saveMeta();
        } else {
            useFallbackTitle(session);
            if (manual) toastr.warning('The model returned no name.', 'Sidekick');
        }
    } catch (err) {
        console.warn('[Sidekick] naming failed', err);
        useFallbackTitle(session);
        if (manual) toastr.error(err.cause?.message ?? err.message, 'Sidekick');
    } finally {
        naming.delete(session.id);
        renderHeader();
        renderHistory();
    }
}

async function send() {
    const input = $('#sidekick_input');
    const text = String(input.val()).trim();
    if ((!text && !pendingAttachments.length) || abortController) return;
    if (uploading > 0) {
        toastr.info('Wait for the attachments to finish uploading.');
        return;
    }
    if (!chatProfileId()) {
        toastr.warning('No connection profile is selected.');
        return;
    }

    const store = getStore();
    let session = getActive();
    if (!session) {
        session = createSession();
        store.sessions.push(session);
        store.activeId = session.id;
    }
    const userMessage = { role: 'user', content: text };
    if (pendingAttachments.length) userMessage.attachments = pendingAttachments;
    session.messages.push(userMessage);
    session.updated = Date.now();
    input.val('').trigger('input');
    pendingAttachments = [];
    renderAttachments();
    await generateReply(session, { restoreOnFail: true });
}

async function generateReply(session, { restoreOnFail = false } = {}) {
    const c = ctx();
    const profileId = chatProfileId();
    if (!profileId) {
        toastr.warning('No connection profile is selected.');
        return;
    }
    const input = $('#sidekick_input');
    editing = null;
    live = { sessionId: session.id };
    resetLive();
    abortController = new AbortController();
    renderAll();
    setBusy(true);

    const addReply = () => {
        session.messages.push({
            role: 'assistant',
            content: live.content || (live.reasoning ? '' : '(empty reply)'),
            ...liveThoughts(),
        });
        session.updated = Date.now();
    };

    try {
        const svc = c.ConnectionManagerRequestService;
        const profile = svc.getProfile(profileId);
        const overrides = getProviderOverrides(profile);
        const prompt = svc.constructPrompt(await buildMessages(session, isChatCompletionProfile(profile)), profileId);
        const result = await svc.sendRequest(profileId, prompt, Number(settings.maxTokens), {
            stream: settings.stream,
            signal: abortController.signal,
        }, overrides);
        if (typeof result === 'function') {
            for await (const chunk of result()) {
                setLive(chunk.text, chunk.state?.reasoning);
            }
        } else {
            setLive(result?.content, result?.reasoning);
        }
        addReply();
        if (settings.autoName && !session.title && session !== temp) generateTitle(session);
    } catch (err) {
        if (live.content || live.reasoning) {
            addReply();
        } else if (restoreOnFail) {
            if (session.messages.at(-1)?.role === 'user') {
                const unsent = session.messages.pop();
                input.val(unsent.content).trigger('input');
                pendingAttachments = unsent.attachments ?? [];
                renderAttachments();
            }
        }
        if (!abortController?.signal.aborted) {
            console.error('[Sidekick]', err);
            toastr.error(err.cause?.message ?? err.message, 'Sidekick');
        }
    } finally {
        live = null;
        abortController = null;
        setBusy(false);
        saveMeta();
        renderAll();
    }
}

/**
 * hack: ConnectionManagerRequestService doesn't send vertexai_auth_mode and profiles don't store it,
 * so the server defaults to Express. Infer the mode from which secret list the profile's key is in.
 */
function getProviderOverrides(profile) {
    if (profile?.api !== 'vertexai') return {};
    const oai = ctx().chatCompletionSettings;
    const secretId = profile['secret-id'];
    const has = key => secretId && secret_state[key]?.some(s => s.id === secretId);
    const mode = has(SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT) ? 'full'
        : has(SECRET_KEYS.VERTEXAI) ? 'express'
            : oai.vertexai_auth_mode;
    return {
        vertexai_auth_mode: mode,
        vertexai_express_project_id: oai.vertexai_express_project_id,
    };
}

function resetLive() {
    Object.assign(live, { content: '', reasoning: '', show: true, startedAt: Date.now(), thinkMs: null, thinkOpen: false });
}

function setLive(text, apiReasoning) {
    if (!live) return;
    const split = splitThinking(text);
    live.content = split.content;
    live.reasoning = joinReasoning(apiReasoning, split.reasoning);
    // thinking ends when the first real text shows up
    if (live.reasoning && live.content && live.thinkMs === null) live.thinkMs = Date.now() - live.startedAt;
    if (!liveFrame) {
        liveFrame = requestAnimationFrame(() => {
            liveFrame = 0;
            updateLiveBubble();
        });
    }
}

function liveThoughts() {
    if (!live.reasoning) return {};
    const ms = live.thinkMs ?? (settings.stream ? Date.now() - live.startedAt : null);
    if (live.thinkOpen) openThoughts.add(live.reasoning);
    return { reasoning: live.reasoning, ...(ms !== null ? { thinkingMs: ms } : {}) };
}

function updateLiveBubble() {
    const turn = $('#sidekick_live');
    if (!turn.length || !live) return;
    const log = $('#sidekick_log')[0];
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    const scrollers = turn.find('.sidekick_think_body').map((_, el) => el.scrollTop).get();
    turn.empty().append(liveTurnContent());
    turn.find('.sidekick_think_body').each((i, el) => {
        // keep following the thoughts while they stream in
        el.scrollTop = scrollers[i] === undefined ? 0 : el.scrollHeight;
    });
    if (nearBottom) log.scrollTop = log.scrollHeight;
}

function liveTurnContent() {
    const parts = [];
    const text = live.content;
    if (settings.showThinking && live.reasoning) {
        const thinking = !text && live.thinkMs === null;
        parts.push(renderThinking(live.reasoning, {
            label: thinking ? 'Thinking' : thinkLabel(live.thinkMs),
            active: thinking,
            open: live.thinkOpen,
            onToggle: open => { live.thinkOpen = open; },
        }));
    }
    if (text) parts.push(renderMarkdown(text));
    else if (!parts.length || live.thinkMs !== null) parts.push($('<div class="sidekick_typing" aria-label="Sidekick is typing"><span></span><span></span><span></span></div>'));
    return parts;
}

function setBusy(busy) {
    $('#sidekick_send')
        .toggleClass('fa-arrow-up', !busy)
        .toggleClass('fa-stop', busy)
        .toggleClass('busy', busy)
        .attr('title', busy ? 'Stop' : 'Send');
    updateSendState();
}

function updateSendState() {
    const ready = Boolean(abortController) || Boolean(String($('#sidekick_input').val() ?? '').trim()) || pendingAttachments.length > 0;
    $('#sidekick_send').toggleClass('ready', ready);
    scheduleDraftEstimate();
}

function renderMarkdown(text) {
    const el = document.createElement('div');
    el.className = 'sidekick_md';
    el.innerHTML = DOMPurify.sanitize(markdown.makeHtml(String(text ?? '')), {
        // no remote images/embeds from model output
        FORBID_TAGS: ['style', 'img', 'iframe', 'form', 'input', 'video', 'audio'],
        ADD_ATTR: ['target'],
    });
    el.querySelectorAll('a').forEach(a => a.setAttribute('rel', 'noopener noreferrer'));
    el.querySelectorAll('pre code').forEach((block) => {
        try {
            hljs.highlightElement(block);
        } catch { /* unknown language */ }
    });
    return el;
}

function thinkLabel(ms) {
    if (ms === null || ms === undefined) return 'Thoughts';
    const s = Math.round(ms / 1000);
    if (s < 1) return 'Thought for a moment';
    return s < 60 ? `Thought for ${s}s` : `Thought for ${Math.floor(s / 60)}m ${s % 60}s`;
}

function renderThinking(reasoning, { label, active = false, open = false, onToggle }) {
    const details = $('<details class="sidekick_think">').toggleClass('active', active).prop('open', open);
    const summary = $('<summary>').append(
        $('<i class="fa-solid fa-brain sidekick_think_icon"></i>'),
        $('<span class="sidekick_think_label">').text(label),
        $('<i class="fa-solid fa-chevron-right sidekick_think_chevron"></i>'),
    );
    const body = $('<div class="sidekick_think_body">').append(renderMarkdown(reasoning));
    details.append(summary, body).on('toggle', () => onToggle?.(details.prop('open')));
    return details;
}

function renderAll() {
    renderHeader();
    renderLog();
    renderHistory();
}

function renderHeader() {
    const session = getActive();
    $('#sidekick_title').text(temp ? 'Temporary chat' : sessionTitle(session)).attr('title', session && !temp ? 'Double-click to rename' : '');
    $('#sidekick_temp').toggleClass('active', Boolean(temp)).attr({
        'aria-pressed': String(Boolean(temp)),
        title: temp ? 'Leave temporary chat' : 'Temporary chat',
    });
    $('#sidekick_window').toggleClass('history_open', view === 'history');
    $('#sidekick_history_toggle').toggleClass('active', view === 'history')
        .attr('title', view === 'history' ? 'Back to conversation' : 'Conversations');
    // nothing to delete in an unsaved conversation
    const noDelete = !session || Boolean(temp) || Boolean(abortController);
    $('#sidekick_delete').toggleClass('disabled', noDelete).attr('aria-disabled', String(noDelete));
}

function renderWelcome() {
    return $('<div class="sidekick_welcome">').append(
        $('<i class="fa-solid sidekick_welcome_icon"></i>').addClass(temp ? 'fa-ghost' : 'fa-user-astronaut'),
        $('<p>').text(temp
            ? 'Sidekick won\'t save this conversation. You lose it when you leave.'
            : 'Ask about the story, check a detail, or brainstorm what comes next.'),
    );
}

function renderTurn(m, index, session) {
    if (m.role === 'user') {
        const turn = $('<div class="sidekick_turn user">');
        if (editing === m) return turn.append(renderEditor(m, index, session));
        const bubble = $('<div class="sidekick_bubble">');
        if (m.content) bubble.append(renderMarkdown(m.content));
        if (m.attachments?.length) bubble.append(renderMessageAttachments(m.attachments));
        return turn.append(bubble);
    }
    const turn = $('<div class="sidekick_turn assistant">');
    if (settings.showThinking && m.reasoning) {
        turn.append(renderThinking(m.reasoning, {
            label: thinkLabel(m.thinkingMs),
            open: openThoughts.has(m.reasoning),
            onToggle: open => open ? openThoughts.add(m.reasoning) : openThoughts.delete(m.reasoning),
        }));
    }
    if (editing === m) turn.append(renderEditor(m, index, session));
    else if (m.content) turn.append(renderMarkdown(m.content));
    return turn;
}

function actionButton(icon, label, handler) {
    return $('<i class="fa-solid" role="button" tabindex="0">').addClass(icon).attr({ title: label, 'aria-label': label })
        .on('click', handler)
        .on('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handler();
            }
        });
}

function renderActions(m, index, session) {
    const row = $('<div class="sidekick_actions">');
    if (m.content) {
        row.append(actionButton('fa-copy', 'Copy', async () => {
            await copyText(m.content);
            toastr.success('Copied to clipboard', '', { timeOut: 1500 });
        }));
    }
    row.append(actionButton('fa-pen', 'Edit', () => {
        editing = m;
        renderLog();
    }));
    if (m.role === 'assistant') {
        row.append(actionButton('fa-rotate-right', 'Regenerate', () => {
            session.messages.splice(index);
            generateReply(session);
        }));
    }
    row.append(actionButton('fa-code-branch', 'Fork into a new conversation', () => forkSession(session, index)));
    row.append(actionButton('fa-trash-can', 'Delete message', async () => {
        const c = ctx();
        const ok = await c.callGenericPopup('Delete this message? This can\'t be undone.', c.POPUP_TYPE.CONFIRM, '', { okButton: 'Delete' });
        // the conversation may have changed while the popup was open
        if (!ok || session.messages[index] !== m) return;
        session.messages.splice(index, 1);
        saveMeta();
        renderAll();
    }));
    const counted = [m.content, ...(m.attachments ?? []).filter(a => a.type === 'text').map(a => a.text)].join('\n');
    if (counted.trim()) {
        const label = $('<span class="sidekick_msg_tokens">').attr('title', 'Tokens in this message (estimate)');
        countTokens(counted).then(n => label.text(`${formatTokens(n)} tokens`));
        row.append(label);
    }
    return row;
}

const tokenCache = new Map();

async function countTokens(text) {
    if (!text) return 0;
    if (!tokenCache.has(text)) {
        if (tokenCache.size > 1000) tokenCache.clear();
        tokenCache.set(text, await ctx().getTokenCountAsync(text));
    }
    return tokenCache.get(text);
}

function formatTokens(n) {
    return n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
}

const contentText = content => Array.isArray(content)
    ? content.filter(p => p.type === 'text').map(p => p.text).join('\n')
    : String(content ?? '');

// token estimate
const estimate = { base: 0, context: 0, history: 0, images: 0, draft: 0 };
let estimateTimer = 0;
let draftTimer = 0;
let estimateSeq = 0;

function scheduleEstimate() {
    clearTimeout(estimateTimer);
    estimateTimer = setTimeout(updateBaseEstimate, 600);
}

async function updateBaseEstimate() {
    if (!settings.enabled || settings.collapsed) return;
    const seq = ++estimateSeq;
    try {
        const session = getActive() ?? { messages: [] };
        const [system, ...history] = await buildMessages(session, false);
        const context = await countTokens(system.content);
        let historyTokens = 0;
        for (const m of history) historyTokens += await countTokens(contentText(m.content));
        if (seq !== estimateSeq) return;
        Object.assign(estimate, {
            context,
            history: historyTokens,
            base: context + historyTokens,
            images: (ctx().chatCompletionSettings.media_inlining ? getChatImages().length : 0) + session.messages.reduce((n, m) => n + (m.attachments ?? []).filter(a => a.type === 'image').length, 0),
        });
        renderEstimate();
    } catch (err) {
        console.debug('[Sidekick] token estimate failed', err);
    }
}

function scheduleDraftEstimate() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(async () => {
        const text = [String($('#sidekick_input').val() ?? ''), ...pendingAttachments.filter(a => a.type === 'text').map(a => a.text)].join('\n');
        estimate.draft = await countTokens(text.trim());
        renderEstimate();
    }, 250);
}

function renderEstimate() {
    const images = estimate.images + pendingAttachments.filter(a => a.type === 'image').length;
    const total = estimate.base + estimate.draft;
    const lines = [
        `About ${total.toLocaleString()} tokens will be sent (estimate)`,
        `System prompt and context: ${estimate.context.toLocaleString()}`,
        `Conversation: ${estimate.history.toLocaleString()}`,
        `Your message: ${estimate.draft.toLocaleString()}`,
    ];
    if (images) lines.push(`Plus ${images} image${images === 1 ? '' : 's'}, not counted`);
    $('#sidekick_tokens')
        .text(`~${formatTokens(total)}${images ? ' +img' : ''}`)
        .attr('title', lines.join('\n'));
}

function renderEditor(m, index, session) {
    const area = $('<textarea class="sidekick_edit_area" rows="1" aria-label="Edit message">').val(m.content);
    const grow = () => {
        area[0].style.height = 'auto';
        area[0].style.height = `${Math.min(area[0].scrollHeight, 320)}px`;
    };
    const cancel = () => {
        editing = null;
        renderLog();
    };
    const save = () => {
        const text = String(area.val()).trim();
        if (!text && !m.attachments?.length) {
            toastr.warning('A message can\'t be empty. Delete it instead.', 'Sidekick');
            return false;
        }
        m.content = text;
        editing = null;
        saveMeta();
        return true;
    };
    const resend = () => {
        if (!save()) return;
        session.messages.splice(index + 1);
        generateReply(session);
    };

    area.on('input', grow).on('keydown', (e) => {
        if (e.key === 'Escape') {
            e.stopPropagation();
            cancel();
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (m.role === 'user') resend();
            else if (save()) renderAll();
        }
    });
    // size and focus once it's in the DOM
    requestAnimationFrame(() => {
        grow();
        area.trigger('focus');
        area[0].setSelectionRange(area[0].value.length, area[0].value.length);
    });

    const buttons = [$('<div class="menu_button">Cancel</div>').on('click', cancel)];
    if (m.role === 'user') {
        buttons.push($('<div class="menu_button">Save</div>').on('click', () => save() && renderAll()));
        buttons.push($('<div class="menu_button sidekick_primary">Save & resend</div>').on('click', resend));
    } else {
        buttons.push($('<div class="menu_button sidekick_primary">Save</div>').on('click', () => save() && renderAll()));
    }
    return $('<div class="sidekick_editor">').append(area, $('<div class="sidekick_editor_actions">').append(buttons));
}

function forkSession(session, index) {
    const store = getStore();
    const fork = createSession(structuredClone(session.messages.slice(0, index + 1)));
    fork.title = `${sessionTitle(session)} (fork)`;
    store.sessions.push(fork);
    openSession(fork.id);
    toastr.info('Forked into a new conversation.', 'Sidekick', { timeOut: 2000 });
}

function renderLog() {
    const log = $('#sidekick_log').empty();
    const session = getActive();
    const messages = session?.messages ?? [];
    const showLive = live?.show && live.sessionId === session?.id;
    if (!messages.length && !showLive) log.append(renderWelcome());
    let lastTurn = null;
    messages.forEach((m, index) => {
        if (m.role === 'assistant' && !m.content && !(settings.showThinking && m.reasoning)) return;
        const turn = renderTurn(m, index, session);
        if (!abortController && editing !== m) turn.append(renderActions(m, index, session));
        log.append(turn);
        lastTurn = turn;
    });
    if (!showLive) lastTurn?.addClass('last');
    if (showLive) {
        log.append($('<div id="sidekick_live" class="sidekick_turn assistant">').append(liveTurnContent()));
    }
    log.scrollTop(log[0].scrollHeight);
    scheduleEstimate();
}

function renderSelectBar(visible) {
    const bar = $('#sidekick_select_bar').toggleClass('open', selecting);
    $('#sidekick_select_toggle').toggleClass('active', selecting)
        .attr('title', selecting ? 'Stop selecting' : 'Select conversations');
    if (!selecting) return;
    const picked = visible.filter(s => selected.has(s.id)).length;
    bar.find('#sidekick_select_all')
        .prop('checked', visible.length > 0 && picked === visible.length)
        .prop('indeterminate', picked > 0 && picked < visible.length)
        .prop('disabled', !visible.length);
    bar.find('#sidekick_select_count').text(selected.size ? `${selected.size} selected` : 'None selected');
    bar.find('#sidekick_delete_selected').toggleClass('disabled', !selected.size);
}

function toggleSelected(id) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    renderHistory();
}

function visibleSessions() {
    const q = historyQuery.toLowerCase();
    return [...getStore().sessions]
        .sort((a, b) => b.updated - a.updated)
        .filter(s => !q || sessionTitle(s).toLowerCase().includes(q)
            || s.messages.some(m => m.content.toLowerCase().includes(q)));
}

function renderHistory() {
    const list = $('#sidekick_sessions').empty();
    const store = getStore();
    const sessions = visibleSessions();
    // drop ids that no longer exist
    for (const id of selected) if (!store.sessions.some(s => s.id === id)) selected.delete(id);
    renderSelectBar(sessions);

    if (!store.sessions.length) {
        list.append('<div class="sidekick_empty">No conversations in this chat yet. Send a message to start one.</div>');
        return;
    }
    if (!sessions.length) {
        list.append($('<div class="sidekick_empty">').text(`Nothing matches "${historyQuery}".`));
        return;
    }

    for (const s of sessions) {
        const count = s.messages.length;
        const when = ctx().timestampToMoment(s.updated).fromNow();
        const isActive = !temp && s.id === store.activeId;
        const row = $('<div class="sidekick_session" tabindex="0">')
            .toggleClass('active', isActive)
            .attr('aria-current', isActive ? 'true' : null);

        if (selecting) {
            const isPicked = selected.has(s.id);
            row.addClass('selecting').toggleClass('selected', isPicked)
                .attr({ role: 'checkbox', 'aria-checked': String(isPicked) });
            row.append($('<input type="checkbox" class="sidekick_check" tabindex="-1" aria-hidden="true">').prop('checked', isPicked));
            row.append($('<div class="sidekick_session_main">').append(
                $('<div class="sidekick_session_title">').text(sessionTitle(s)),
                $('<div class="sidekick_session_meta">').text(`${count} message${count === 1 ? '' : 's'}, ${when}`),
            ));
            row.on('click', () => toggleSelected(s.id));
            row.on('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleSelected(s.id);
                    $(`#sidekick_sessions .sidekick_session`).eq(sessions.indexOf(s)).trigger('focus');
                }
            });
            list.append(row);
            continue;
        }
        row.attr('role', 'button');
        const title = $('<div class="sidekick_session_title">').text(sessionTitle(s));
        const meta = $('<div class="sidekick_session_meta">').text(`${count} message${count === 1 ? '' : 's'}, ${when}`);
        const rename = $('<i class="fa-solid fa-pen" role="button" tabindex="0" title="Rename"></i>');
        const del = $('<i class="fa-solid fa-trash-can" role="button" tabindex="0" title="Delete"></i>');
        const busy = naming.has(s.id);
        const autoName = $('<i class="fa-solid" role="button" tabindex="0"></i>')
            .addClass(busy ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles')
            .attr('title', busy ? 'Generating name…' : 'Generate name');

        row.append($('<div class="sidekick_session_main">').append(title, meta));
        row.append($('<div class="sidekick_session_actions">').toggleClass('busy', busy).append(autoName, rename, del));

        row.on('click', () => openSession(s.id));
        row.on('keydown', (e) => {
            if (e.target !== row[0]) return;
            if (e.key === 'Enter') openSession(s.id);
            if (e.key === 'F2') startRename(title, s);
            if (e.key === 'Delete') deleteSessions([s]);
        });
        rename.on('click', (e) => {
            e.stopPropagation();
            startRename(title, s);
        });
        del.on('click', (e) => {
            e.stopPropagation();
            deleteSessions([s]);
        });
        autoName.on('click', (e) => {
            e.stopPropagation();
            generateTitle(s, true);
        });
        rename.add(del).add(autoName).on('keydown', function (e) {
            if (e.key === 'Enter') {
                e.stopPropagation();
                $(this).trigger('click');
            }
        });
        list.append(row);
    }
}

function setView(next) {
    view = next;
    if (view !== 'history') {
        selecting = false;
        selected.clear();
    }
    renderHeader();
    if (view === 'history') {
        renderHistory();
        $('#sidekick_search').trigger('focus');
    } else {
        $('#sidekick_input').trigger('focus');
    }
}

function clamp(el, x, y) {
    const maxX = window.innerWidth - el.offsetWidth;
    const maxY = window.innerHeight - el.offsetHeight;
    return { x: Math.max(0, Math.min(x, maxX)), y: Math.max(0, Math.min(y, maxY)) };
}

// matches SillyTavern's own mobile layout breakpoint
const mobileQuery = window.matchMedia('(max-width: 1000px)');
const posKey = base => mobileQuery.matches ? `${base}Mobile` : base;

function makeDraggable(el, handle, posBase, onClick) {
    handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.closest('.sidekick_nodrag')) return;
        const startX = e.clientX, startY = e.clientY;
        const rect = el.getBoundingClientRect();
        let moved = false;

        const move = (ev) => {
            const dx = ev.clientX - startX, dy = ev.clientY - startY;
            if (!moved && Math.hypot(dx, dy) < 4) return;
            if (!moved) handle.setPointerCapture(ev.pointerId);
            moved = true;
            const p = clamp(el, rect.left + dx, rect.top + dy);
            el.style.left = `${p.x}px`;
            el.style.top = `${p.y}px`;
        };
        const up = () => {
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', up);
            handle.removeEventListener('pointercancel', up);
            if (moved) {
                settings[posKey(posBase)] = { x: el.offsetLeft, y: el.offsetTop };
                save();
            } else {
                onClick?.();
            }
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
    });
}

function placeAt(el, pos) {
    const margin = 16;
    pos ??= { x: window.innerWidth - el.offsetWidth - margin, y: window.innerHeight - el.offsetHeight - margin };
    const p = clamp(el, pos.x, pos.y);
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
}

function updateVisibility() {
    const win = document.getElementById('sidekick_window');
    const icon = document.getElementById('sidekick_icon');
    const showWindow = settings.enabled && !settings.collapsed;
    win.style.display = showWindow ? 'flex' : 'none';
    icon.style.display = settings.enabled && settings.collapsed ? 'flex' : 'none';
    if (showWindow) {
        placeAt(win, settings[posKey('windowPos')]);
        renderAll();
    } else if (settings.enabled) {
        placeAt(icon, settings[posKey('iconPos')]);
    }
}

// the composer menu and the settings drawer edit the same settings
function syncIncludeBoxes() {
    $('[data-include]').each(function () {
        this.checked = settings.include[this.dataset.include];
    });
    $('#sidekick_hidden, #sidekick_menu_hidden').prop('checked', settings.includeHidden);
    $('#sidekick_menu_hidden').prop('disabled', !settings.include.chat);
    $('#sidekick_depth, label[for="sidekick_depth"]').toggle(settings.include.chat);
    const values = Object.values(settings.include);
    const none = !values.some(Boolean);
    $('#sidekick_context_toggle').toggleClass('none', none)
        .attr('title', none ? 'Nothing from the roleplay is sent' : 'Choose what\'s sent');
    $('#sidekick_context_all').text(values.every(Boolean) ? 'Turn all off' : 'Turn all on');
}

function setPopover(pop, open) {
    pop.toggleClass('open', open);
    pop.find('.sidekick_pop_toggle').toggleClass('active', open).attr('aria-expanded', String(open));
    if (!open) return;
    const menu = pop.find('.sidekick_pop_menu');
    (menu.find('[aria-current="true"]')[0] ?? menu.find('input:enabled')[0] ?? menu.find('button')[0])?.focus();
}

function switchPreset(id) {
    const preset = settings.presets.find(p => p.id === id);
    if (!preset) return;
    loadPresetValues(preset);
    save();
    fillSettingsUI();
    renderPresets();
    renderLog();
}

async function createPreset() {
    const c = ctx();
    const name = await c.callGenericPopup('Name the new preset. It starts with the current preset\'s settings.', c.POPUP_TYPE.INPUT, '');
    if (typeof name !== 'string' || !name.trim()) return;
    const preset = { id: c.uuidv4(), name: name.trim().slice(0, 60), values: pickPreset(settings) };
    settings.presets.push(preset);
    switchPreset(preset.id);
}

async function deletePreset() {
    const preset = activePreset();
    if (!preset || settings.presets.length < 2) return;
    const c = ctx();
    const what = $('<b>').text(preset.name).prop('outerHTML');
    const ok = await c.callGenericPopup(`Delete the preset ${what}? This can't be undone.`, c.POPUP_TYPE.CONFIRM, '', { okButton: 'Delete' });
    if (!ok) return;
    settings.presets = settings.presets.filter(p => p !== preset);
    switchPreset(settings.presets[0].id);
}

function renderPresets() {
    const active = activePreset();
    const single = settings.presets.length < 2;
    $('#sidekick_preset').empty()
        .append(settings.presets.map(p => $('<option>').val(p.id).text(p.name)))
        .val(active.id);
    $('#sidekick_preset_delete').toggleClass('disabled', single).attr('aria-disabled', String(single));
    $('#sidekick_preset_toggle').attr('title', `Preset: ${active.name}`)
        .find('.sidekick_preset_name').text(active.name);
    $('#sidekick_preset_list').empty().append(settings.presets.map(p => $('<button type="button" class="sidekick_preset_item">')
        .attr('aria-current', p === active ? 'true' : null)
        .append($('<i class="fa-solid fa-check"></i>'), $('<span>').text(p.name))
        .on('click', () => {
            setPopover($('#sidekick_presets'), false);
            $('#sidekick_preset_toggle').trigger('focus');
            switchPreset(p.id);
        })));
}

function setCollapsed(collapsed) {
    settings.collapsed = collapsed;
    save();
    updateVisibility();
}

function createFloatingUI() {
    $('body').append(`
        <div id="sidekick_icon" title="Open Sidekick"><i class="fa-solid fa-user-astronaut"></i></div>
        <div id="sidekick_window">
            <div id="sidekick_header">
                <i id="sidekick_history_toggle" class="fa-solid fa-clock-rotate-left sidekick_nodrag" role="button" tabindex="0" title="Conversations"></i>
                <span id="sidekick_title"></span>
                <i id="sidekick_delete" class="fa-solid fa-trash-can sidekick_nodrag" role="button" tabindex="0" title="Delete conversation"></i>
                <i id="sidekick_temp" class="fa-solid fa-ghost sidekick_nodrag" role="button" tabindex="0" aria-pressed="false" title="Temporary chat"></i>
                <i id="sidekick_new" class="fa-solid fa-pen-to-square sidekick_nodrag" role="button" tabindex="0" title="New conversation"></i>
                <i id="sidekick_collapse" class="fa-solid fa-minus sidekick_nodrag" role="button" tabindex="0" title="Collapse"></i>
            </div>
            <div id="sidekick_body">
                <div id="sidekick_chat">
                    <div id="sidekick_log"></div>
                    <div id="sidekick_form">
                        <div id="sidekick_composer">
                            <div id="sidekick_attachments"></div>
                            <textarea id="sidekick_input" rows="1" placeholder="Message Sidekick…" aria-label="Message Sidekick"></textarea>
                            <div id="sidekick_composer_bar">
                                <div id="sidekick_composer_left">
                                    <i id="sidekick_attach" class="fa-solid fa-paperclip" role="button" tabindex="0" title="Attach images or text files"></i>
                                    <input id="sidekick_file" type="file" multiple hidden accept="image/*,text/*,.md,.json,.csv,.yaml,.yml,.log">
                                    <div id="sidekick_presets" class="sidekick_pop">
                                        <button id="sidekick_preset_toggle" class="sidekick_pop_toggle" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="sidekick_preset_menu">
                                            <span class="sidekick_preset_name"></span><i class="fa-solid fa-chevron-up"></i>
                                        </button>
                                        <div id="sidekick_preset_menu" class="sidekick_pop_menu" role="group" aria-labelledby="sidekick_preset_heading">
                                            <div class="sidekick_pop_head"><span id="sidekick_preset_heading" class="sidekick_pop_heading">Preset</span></div>
                                            <div id="sidekick_preset_list"></div>
                                        </div>
                                    </div>
                                </div>
                                <div id="sidekick_composer_right">
                                    <div id="sidekick_context" class="sidekick_pop">
                                        <i id="sidekick_context_toggle" class="fa-solid fa-sliders sidekick_pop_toggle" role="button" tabindex="0" title="Choose what's sent" aria-haspopup="true" aria-expanded="false" aria-controls="sidekick_context_menu"></i>
                                        <div id="sidekick_context_menu" class="sidekick_pop_menu" role="group" aria-labelledby="sidekick_context_heading">
                                            <div class="sidekick_pop_head">
                                                <span id="sidekick_context_heading" class="sidekick_pop_heading">Include in prompt</span>
                                                <button id="sidekick_context_all" type="button"></button>
                                            </div>
                                            ${Object.entries(INCLUDE_LABELS).map(([key, label]) => `
                                            <label class="checkbox_label"><input type="checkbox" data-include="${key}"> ${label}</label>`).join('')}
                                            <label class="checkbox_label sidekick_sub"><input id="sidekick_menu_hidden" type="checkbox"> Hidden messages</label>
                                        </div>
                                    </div>
                                    <span id="sidekick_tokens" class="sidekick_tokens"></span>
                                    <i id="sidekick_send" class="fa-solid fa-arrow-up" role="button" tabindex="0" title="Send"></i>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div id="sidekick_history" aria-label="Conversations">
                    <div id="sidekick_history_bar">
                        <input id="sidekick_search" type="search" class="text_pole" placeholder="Search conversations" aria-label="Search conversations">
                        <i id="sidekick_select_toggle" class="fa-solid fa-list-check" role="button" tabindex="0" title="Select conversations"></i>
                    </div>
                    <div id="sidekick_sessions"></div>
                    <div id="sidekick_select_bar">
                        <label class="checkbox_label"><input id="sidekick_select_all" type="checkbox"> All</label>
                        <span id="sidekick_select_count"></span>
                        <div id="sidekick_select_cancel" class="menu_button" role="button" tabindex="0">Cancel</div>
                        <div id="sidekick_delete_selected" class="menu_button" role="button" tabindex="0"><i class="fa-solid fa-trash-can"></i> Delete</div>
                    </div>
                </div>
            </div>
        </div>`);

    const win = document.getElementById('sidekick_window');
    const icon = document.getElementById('sidekick_icon');
    makeDraggable(win, document.getElementById('sidekick_header'), 'windowPos');
    makeDraggable(icon, icon, 'iconPos', () => setCollapsed(false));

    const onActivate = (sel, fn) => $(sel).on('click', fn).on('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            fn();
        }
    });
    onActivate('#sidekick_collapse', () => setCollapsed(true));
    onActivate('#sidekick_history_toggle', () => setView(view === 'history' ? 'chat' : 'history'));
    onActivate('#sidekick_new', newConversation);
    onActivate('#sidekick_temp', toggleTemp);
    onActivate('#sidekick_delete', () => {
        const session = getActive();
        if (session && !abortController) deleteSessions([session]);
    });
    onActivate('#sidekick_select_toggle', () => setSelecting(!selecting));
    onActivate('#sidekick_select_cancel', () => setSelecting(false));
    onActivate('#sidekick_delete_selected', async () => {
        const picked = getStore().sessions.filter(s => selected.has(s.id));
        if (await deleteSessions(picked) && !getStore().sessions.length) setSelecting(false);
    });
    $('#sidekick_select_all').on('input', function () {
        // applies to what the search currently shows
        visibleSessions().forEach(s => this.checked ? selected.add(s.id) : selected.delete(s.id));
        renderHistory();
    });
    onActivate('#sidekick_send', () => abortController ? abortController.abort() : send());
    const togglePopover = sel => setPopover($(sel), !$(sel).hasClass('open'));
    onActivate('#sidekick_context_toggle', () => togglePopover('#sidekick_context'));
    $('#sidekick_preset_toggle').on('click', () => togglePopover('#sidekick_presets'));
    $('#sidekick_context_menu').on('input', 'input', function () {
        if (this.dataset.include) settings.include[this.dataset.include] = this.checked;
        else settings.includeHidden = this.checked;
        save();
        syncIncludeBoxes();
    });
    $('#sidekick_context_all').on('click', () => {
        const on = !Object.values(settings.include).every(Boolean);
        for (const key of Object.keys(settings.include)) settings.include[key] = on;
        save();
        syncIncludeBoxes();
    });
    $('.sidekick_pop').on('keydown', function (e) {
        if (e.key !== 'Escape' || !$(this).hasClass('open')) return;
        e.stopPropagation();
        setPopover($(this), false);
        $(this).find('.sidekick_pop_toggle').trigger('focus');
    });
    $(document).on('pointerdown', (e) => {
        $('.sidekick_pop.open').each((_, el) => {
            if (!el.contains(e.target)) setPopover($(el), false);
        });
    });
    syncIncludeBoxes();

    $('#sidekick_title').on('dblclick', function () {
        const session = getActive();
        if (session && !temp) startRename(this, session);
    });
    $('#sidekick_search').on('input', function () {
        historyQuery = this.value;
        renderHistory();
    });
    $('#sidekick_window').on('keydown', (e) => {
        if (e.key !== 'Escape' || view !== 'history') return;
        if (selecting) setSelecting(false);
        else setView('chat');
    });
    onActivate('#sidekick_attach', () => $('#sidekick_file').trigger('click'));
    $('#sidekick_file').on('change', function () {
        addFiles([...this.files]);
        this.value = '';
    });
    $('#sidekick_input').on('paste', (e) => {
        const files = [...(e.originalEvent.clipboardData?.files ?? [])];
        if (!files.length) return;
        e.preventDefault();
        addFiles(files);
    });
    let dragDepth = 0;
    const hasFiles = e => [...(e.originalEvent.dataTransfer?.types ?? [])].includes('Files');
    $('#sidekick_window')
        .on('dragenter', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            dragDepth++;
            $('#sidekick_window').addClass('dropping');
        })
        .on('dragover', (e) => {
            if (hasFiles(e)) e.preventDefault();
        })
        .on('dragleave', () => {
            if (--dragDepth <= 0) {
                dragDepth = 0;
                $('#sidekick_window').removeClass('dropping');
            }
        })
        .on('drop', (e) => {
            dragDepth = 0;
            $('#sidekick_window').removeClass('dropping');
            if (!hasFiles(e)) return;
            e.preventDefault();
            addFiles([...e.originalEvent.dataTransfer.files]);
        });
    $('#sidekick_input').on('input', function () {
        this.style.height = 'auto';
        this.style.height = `${Math.min(this.scrollHeight, 160)}px`;
        updateSendState();
    });
    $('#sidekick_input').on('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
        }
    });
    window.addEventListener('resize', () => updateVisibility());
    updateSendState();

    const wandItem = $(`<div id="sidekick_wand_button" class="list-group-item flex-container flexGap5">
        <div class="fa-solid fa-user-astronaut extensionsMenuExtensionButton"></div><span>Open Sidekick</span></div>`);
    wandItem.on('click', () => {
        settings.enabled = true;
        $('#sidekick_enabled').prop('checked', true);
        setCollapsed(false);
    });
    $('#extensionsMenu').append(wandItem);
}

// refill the drawer after a preset switch
const settingsFillers = [];

function fillSettingsUI() {
    settingsFillers.forEach(fill => fill());
    syncIncludeBoxes();
}

function createSettingsUI() {
    const includeBoxes = Object.entries(INCLUDE_LABELS).map(([key, label]) => `
        <label class="checkbox_label"><input type="checkbox" data-include="${key}"> ${label}</label>`).join('');

    $('#extensions_settings2').append(`
        <div class="sidekick_settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Sidekick</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label class="checkbox_label"><input id="sidekick_enabled" type="checkbox"> Show Sidekick</label>

                    <label for="sidekick_preset">Preset</label>
                    <div class="sidekick_preset_row">
                        <select id="sidekick_preset" class="text_pole"></select>
                        <i id="sidekick_preset_new" class="menu_button fa-solid fa-plus" role="button" tabindex="0" title="New preset" aria-label="New preset"></i>
                        <i id="sidekick_preset_delete" class="menu_button fa-solid fa-trash-can" role="button" tabindex="0" title="Delete preset" aria-label="Delete preset"></i>
                    </div>

                    <label for="sidekick_profile">Connection profile</label>
                    <select id="sidekick_profile" class="text_pole"></select>

                    <label for="sidekick_max_tokens">Max response tokens</label>
                    <input id="sidekick_max_tokens" type="number" class="text_pole" min="16" step="16">
                    <label class="checkbox_label"><input id="sidekick_stream" type="checkbox"> Stream replies</label>
                    <label class="checkbox_label"><input id="sidekick_show_thinking" type="checkbox"> Show thinking</label>

                    <h4>What the sidekick can see</h4>
                    ${includeBoxes}
                    <label class="checkbox_label"><input id="sidekick_hidden" type="checkbox"> Include hidden messages</label>
                    <label for="sidekick_depth">Chat messages to include (0 = all)</label>
                    <input id="sidekick_depth" type="number" class="text_pole" min="0">

                    <div class="sidekick_heading">
                        <h4>System prompt</h4>
                        <i id="sidekick_reset_system" class="menu_button fa-solid fa-rotate-left" role="button" tabindex="0" title="Reset to default"></i>
                    </div>
                    <textarea id="sidekick_system" class="text_pole textarea_compact" rows="6"></textarea>

                    <h4>Conversation names</h4>
                    <label class="checkbox_label"><input id="sidekick_auto_name" type="checkbox"> Name new conversations after the first reply</label>
                    <label for="sidekick_name_profile">Naming profile</label>
                    <select id="sidekick_name_profile" class="text_pole"></select>
                    <label for="sidekick_name_model">Naming model</label>
                    <input id="sidekick_name_model" type="text" class="text_pole" placeholder="Profile's model" autocomplete="off">
                    <small class="sidekick_hint">A small, fast model is recommended. Leave empty to use the profile's own model.</small>
                    <div class="sidekick_heading">
                        <label for="sidekick_name_prompt">Naming prompt</label>
                        <i id="sidekick_reset_name" class="menu_button fa-solid fa-rotate-left" role="button" tabindex="0" title="Reset to default"></i>
                    </div>
                    <textarea id="sidekick_name_prompt" class="text_pole textarea_compact" rows="3"></textarea>
                </div>
            </div>
        </div>`);

    const bindCheck = (sel, key, after) => {
        settingsFillers.push(() => $(sel).prop('checked', settings[key]));
        $(sel).on('input', function () {
            settings[key] = this.checked;
            save();
            after?.();
        });
    };
    const bindValue = (sel, key, parse = String) => {
        settingsFillers.push(() => $(sel).val(settings[key]));
        $(sel).on('input', function () {
            settings[key] = parse(this.value);
            save();
        });
    };

    $('#sidekick_enabled').prop('checked', settings.enabled).on('input', function () {
        settings.enabled = this.checked;
        save();
        updateVisibility();
    });
    bindValue('#sidekick_max_tokens', 'maxTokens', Number);
    bindCheck('#sidekick_stream', 'stream');
    bindCheck('#sidekick_show_thinking', 'showThinking', renderLog);
    bindValue('#sidekick_depth', 'historyDepth', Number);
    $('#sidekick_hidden').on('input', function () {
        settings.includeHidden = this.checked;
        save();
        syncIncludeBoxes();
    });
    bindValue('#sidekick_system', 'systemPrompt');
    bindCheck('#sidekick_auto_name', 'autoName');
    bindValue('#sidekick_name_model', 'nameModel');
    bindValue('#sidekick_name_prompt', 'namePrompt');

    $('.sidekick_settings [data-include]').each(function () {
        const key = this.dataset.include;
        $(this).on('input', () => {
            settings.include[key] = this.checked;
            save();
            syncIncludeBoxes();
        });
    });

    $('#sidekick_reset_system').on('click', () => {
        settings.systemPrompt = DEFAULT_SYSTEM_PROMPT;
        $('#sidekick_system').val(DEFAULT_SYSTEM_PROMPT);
        save();
    });
    $('#sidekick_reset_name').on('click', () => {
        settings.namePrompt = DEFAULT_NAME_PROMPT;
        $('#sidekick_name_prompt').val(DEFAULT_NAME_PROMPT);
        save();
    });

    $('#sidekick_preset').on('change', function () {
        switchPreset(this.value);
    });
    $('#sidekick_preset_new').on('click', createPreset);
    $('#sidekick_preset_delete').on('click', deletePreset);

    $('#sidekick_reset_system, #sidekick_reset_name, #sidekick_preset_new, #sidekick_preset_delete').on('keydown', (e) => {
        if (e.key === 'Enter') $(e.currentTarget).trigger('click');
    });

    try {
        ctx().ConnectionManagerRequestService.handleDropdown('#sidekick_profile', settings.profileId, (profile) => {
            settings.profileId = profile?.id ?? '';
            save();
        });
        $('#sidekick_profile option[value=""]').text('Use current profile').attr('data-i18n', 'Use current profile');
        ctx().ConnectionManagerRequestService.handleDropdown('#sidekick_name_profile', settings.nameProfileId, (profile) => {
            settings.nameProfileId = profile?.id ?? '';
            save();
        });
        $('#sidekick_name_profile option[value=""]').text('Same as chat profile').attr('data-i18n', 'Same as chat profile');
        settingsFillers.push(() => {
            $('#sidekick_profile').val(settings.profileId);
            $('#sidekick_name_profile').val(settings.nameProfileId);
        });
    } catch (err) {
        $('#sidekick_profile, #sidekick_name_profile').replaceWith('<div class="sidekick_warn">Enable the Connection Manager extension to pick a profile.</div>');
    }
    fillSettingsUI();
}

jQuery(() => {
    loadSettings();
    createSettingsUI();
    createFloatingUI();
    renderPresets();
    updateVisibility();

    const { eventSource, eventTypes } = ctx();
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        abortController?.abort();
        temp = null;
        historyQuery = '';
        editing = null;
        selecting = false;
        selected.clear();
        $('#sidekick_search').val('');
        if (!settings.collapsed) renderAll();
    });
    // the roleplay itself is part of the prompt
    for (const type of ['MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'WORLDINFO_UPDATED']) {
        eventSource.on(eventTypes[type], scheduleEstimate);
    }
});
