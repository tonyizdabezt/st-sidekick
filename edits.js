const BLOCK = /<sidekick_edit\b([^>]*)>([\s\S]*?)<\/sidekick_edit>/gi;
const UNFINISHED = /<sidekick_edit\b[\s\S]*$/i;
const OLD = /<old>([\s\S]*?)<\/old>/i;
const NEW = /<new>([\s\S]*)<\/new>/i;
const CARD_FIELDS = ['description', 'personality', 'scenario', 'mes_example'];

const normalize = text => String(text ?? '').replace(/\r\n/g, '\n');
const unwrap = text => text === undefined ? undefined : normalize(text).replace(/^\n|\n$/g, '');

function parseBlock(attrs, body) {
    const attr = name => attrs.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'))?.[1];
    const target = attr('target');
    const edit = { target, old: unwrap(body.match(OLD)?.[1]), new: unwrap(body.match(NEW)?.[1]) };
    if (edit.new === undefined) return { ...edit, error: 'The proposal has no new text.' };
    if (target === 'message') {
        const id = attr('id') ?? '';
        if (!/^#?\d+$/.test(id)) return { ...edit, error: 'The proposal doesn\'t say which message to change.' };
        return { ...edit, id: Number(id.replace('#', '')) };
    }
    return CARD_FIELDS.includes(target) ? edit : { ...edit, error: `Sidekick can't edit "${target}".` };
}

export function splitEdits(reply) {
    const edits = [];
    const text = String(reply ?? '')
        .replace(BLOCK, (_, attrs, body) => {
            edits.push(parseBlock(attrs, body));
            return '';
        })
        .replace(UNFINISHED, '');
    return { text: (edits.length ? text.replace(/```\w*\s*```/g, '') : text).trim(), edits };
}

export function replaceText(current, edit) {
    const text = normalize(current);
    if (edit.old === undefined) {
        if (edit.before !== undefined && edit.before !== text) return { error: 'This text changed after the proposal.' };
        return { after: edit.new };
    }
    if (!edit.old) return { error: 'The text to replace is empty.' };
    const parts = text.split(edit.old);
    if (parts.length === 1) return { error: 'The text to replace wasn\'t found.' };
    if (parts.length > 2) return { error: `The text to replace appears ${parts.length - 1} times.` };
    return { after: parts.join(edit.new) };
}

export function trimContext(text, isFirst, isLast, keep = 160) {
    const head = isFirst ? 0 : keep;
    const tail = isLast ? 0 : keep;
    if ((isFirst && isLast) || text.length <= head + tail + 1) return text;
    return `${text.slice(0, head)}…${tail ? text.slice(-tail) : ''}`;
}
