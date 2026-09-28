# Sidekick

A SillyTavern extension that gives you an out-of-character assistant beside your roleplay. Sidekick reads the story and talks it through with you: check a detail, catch a contradiction, brainstorm the next scene.

## Features

- **Floating window**: drag it anywhere, resize it, or collapse it into a draggable icon
- **Any connection profile**: pick one, or follow whichever profile you have selected
- **You choose the context**: character card, persona, scenario, example dialogue, world info, SillyTavern's own prompts, and how many chat messages to include
- **Editable system prompt**
- **Presets**: save different setups and switch between them
- **Temporary chats** that Sidekick never saves
- **Streaming replies** with markdown and a collapsible thinking block
- **Attachments**: paste, drop, or pick images and text files
- **Conversation history per chat**: search, rename, fork, delete one or many
- **Automatic names**: a model of your choice titles each conversation by topic
- **Message actions**: copy, edit, regenerate, fork, delete
- **Token counts**: an estimate of the next request beside Send, and a count on every message

## Installation

1. Open **Extensions** → **Install extension**
2. Paste `https://github.com/tonyizdabezt/st-sidekick`
3. Reload SillyTavern

Sidekick needs the built-in **Connection Manager** extension turned on.

## Usage

Click the astronaut icon to open the window, or pick **Open Sidekick** from the wand menu. Sidekick starts minimized on every visit and remembers where you left the icon and the window.

In the window:

- Type a message and press Enter. Shift+Enter adds a line break.
- The clock icon opens your conversations for the current chat.
- The trash icon deletes the open conversation and takes you to your latest one.
- The ghost icon starts a temporary chat. Sidekick drops it when you refresh or leave.
- The pen icon starts a new conversation.
- The name beside the paperclip switches presets.
- The sliders icon beside the token count picks what goes into the prompt.
- Hover a message to copy, edit, regenerate, fork, or delete it.

## Settings

Find them under **Extensions** → **Sidekick**.

| Option | What it does |
|--------|--------------|
| **Preset** | Pick the active preset. Each preset keeps its own copy of every option below. |
| **Connection profile** | Profile for replies. "Use current profile" follows your selection. |
| **Max response tokens** | Reply length cap |
| **Stream replies** | Show text as it arrives |
| **Show thinking** | Show or hide thinking blocks |
| **What the sidekick can see** | Pick which parts of the roleplay go into the prompt |
| **System prompt** | Sidekick's instructions. `{{char}}` and `{{user}}` work here. |
| **Conversation names** | Turn auto-naming on or off, and set its profile, model, and prompt |

## Notes

- Images need a Chat Completion profile with a vision model. Text Completion models get a short note that an image was attached.
- Sidekick saves conversations in each chat's metadata and uploaded images under `images/Sidekick` in your user data.

## License

MIT License. See [LICENSE](LICENSE) for details.
