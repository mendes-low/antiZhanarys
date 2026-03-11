# Telegram Sticker Quota Bot

A multi-group Telegram moderation bot that:

- counts stickers per user,
- enforces a daily sticker limit per group,
- supports multiple groups with separate settings,
- can either delete extra stickers or temporarily restrict sticker sending.

## Features

- `/setstickerlimit 10` — set daily sticker limit for the current group
- `/settimezone Asia/Almaty` — set the group's reset timezone
- `/setstickeraction delete` or `/setstickeraction restrict`
- `/setrestrictminutes 60` — only used when action is `restrict`
- `/stickerlimit` — show current group settings
- `/mystickers` — show your sticker count for today
- `/leaderboard` — top sticker senders for today

## Important Telegram setup

For reliable counting in groups, add the bot as an **administrator**.
Recommended admin rights:

- Delete messages
- Restrict users (only needed for `restrict` action)

If the bot is **not** an admin, you must disable privacy mode in `@BotFather` and re-add the bot to the group.

## Environment variables

See `.env.example`.

## Local run

```bash
npm install
npm start
```

## Deploy

You can deploy this as a **single instance** on Railway or Render.
Do not scale it horizontally while using long polling, or you may process updates more than once.
