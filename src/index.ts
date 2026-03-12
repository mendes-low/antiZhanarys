import "dotenv/config";
import express from "express";
import { Pool } from "pg";
import { Telegraf, Context } from "telegraf";
import { message } from "telegraf/filters";

type StickerAction = "delete" | "restrict";

type GroupSettings = {
    chat_id: string;
    title: string | null;
    sticker_limit: number;
    timezone: string;
    action: StickerAction;
    restrict_minutes: number;
    enabled: boolean;
};

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = Number(process.env.PORT || 3000);
const DEFAULT_STICKER_LIMIT = Number(process.env.DEFAULT_STICKER_LIMIT || 10);
const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || "UTC";
const DEFAULT_ACTION = (process.env.DEFAULT_ACTION ||
    "delete") as StickerAction;
const DEFAULT_RESTRICT_MINUTES = Number(
    process.env.DEFAULT_RESTRICT_MINUTES || 60,
);

if (!BOT_TOKEN) {
    throw new Error("BOT_TOKEN is required");
}

if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
}

if (!isValidTimeZone(DEFAULT_TIMEZONE)) {
    throw new Error(`Invalid DEFAULT_TIMEZONE: ${DEFAULT_TIMEZONE}`);
}

if (!["delete", "restrict"].includes(DEFAULT_ACTION)) {
    throw new Error("DEFAULT_ACTION must be delete or restrict");
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: shouldUseSsl(DATABASE_URL) ? { rejectUnauthorized: false } : false,
});

const bot = new Telegraf(BOT_TOKEN);

function shouldUseSsl(url: string): boolean {
    return (
        /render\.com|railway\.internal|railway\.app/i.test(url) ||
        process.env.PGSSL === "true"
    );
}

function isGroupChat(ctx: Context): boolean {
    return ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
}

function isValidTimeZone(timeZone: string): boolean {
    try {
        Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
        return true;
    } catch {
        return false;
    }
}

function getDayKey(date: Date, timeZone: string): string {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date);

    const year = parts.find((p) => p.type === "year")?.value;
    const month = parts.find((p) => p.type === "month")?.value;
    const day = parts.find((p) => p.type === "day")?.value;

    if (!year || !month || !day) {
        throw new Error("Failed to build day key");
    }

    return `${year}-${month}-${day}`;
}

function escapeHtml(input: string): string {
    return input
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

async function initDb(): Promise<void> {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS groups (
      chat_id BIGINT PRIMARY KEY,
      title TEXT,
      sticker_limit INTEGER NOT NULL DEFAULT 10 CHECK (sticker_limit > 0),
      timezone TEXT NOT NULL DEFAULT 'UTC',
      action TEXT NOT NULL DEFAULT 'delete' CHECK (action IN ('delete', 'restrict')),
      restrict_minutes INTEGER NOT NULL DEFAULT 60 CHECK (restrict_minutes > 0),
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

    await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_usage (
      chat_id BIGINT NOT NULL,
      user_id BIGINT NOT NULL,
      day_key TEXT NOT NULL,
      sticker_count INTEGER NOT NULL DEFAULT 0,
      first_name TEXT,
      username TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (chat_id, user_id, day_key)
    );
  `);

    await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_daily_usage_lookup
    ON daily_usage (chat_id, day_key, sticker_count DESC);
  `);
}

async function ensureGroup(chatId: number, title?: string): Promise<void> {
    await pool.query(
        `
      INSERT INTO groups (chat_id, title, sticker_limit, timezone, action, restrict_minutes)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (chat_id)
      DO UPDATE SET
        title = COALESCE(EXCLUDED.title, groups.title),
        updated_at = NOW()
    `,
        [
            chatId,
            title ?? null,
            DEFAULT_STICKER_LIMIT,
            DEFAULT_TIMEZONE,
            DEFAULT_ACTION,
            DEFAULT_RESTRICT_MINUTES,
        ],
    );
}

async function getGroupSettings(chatId: number): Promise<GroupSettings> {
    await ensureGroup(chatId);
    const result = await pool.query<GroupSettings>(
        `SELECT chat_id::text, title, sticker_limit, timezone, action, restrict_minutes, enabled FROM groups WHERE chat_id = $1`,
        [chatId],
    );

    if (!result.rows[0]) {
        throw new Error("Group settings not found");
    }

    return result.rows[0];
}

async function updateGroupSettings(
    chatId: number,
    patch: Partial<
        Pick<
            GroupSettings,
            | "sticker_limit"
            | "timezone"
            | "action"
            | "restrict_minutes"
            | "enabled"
        >
    >,
): Promise<void> {
    const current = await getGroupSettings(chatId);

    await pool.query(
        `
      UPDATE groups
      SET sticker_limit = $2,
          timezone = $3,
          action = $4,
          restrict_minutes = $5,
          enabled = $6,
          updated_at = NOW()
      WHERE chat_id = $1
    `,
        [
            chatId,
            patch.sticker_limit ?? current.sticker_limit,
            patch.timezone ?? current.timezone,
            patch.action ?? current.action,
            patch.restrict_minutes ?? current.restrict_minutes,
            patch.enabled ?? current.enabled,
        ],
    );
}

async function isAdmin(ctx: Context): Promise<boolean> {
    if (!ctx.chat || !ctx.from) {
        return false;
    }

    const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
    return member.status === "administrator" || member.status === "creator";
}

async function getUserStickerCount(
    chatId: number,
    userId: number,
    dayKey: string,
): Promise<number> {
    const result = await pool.query<{ sticker_count: number }>(
        `SELECT sticker_count FROM daily_usage WHERE chat_id = $1 AND user_id = $2 AND day_key = $3`,
        [chatId, userId, dayKey],
    );

    return result.rows[0]?.sticker_count ?? 0;
}

async function incrementStickerCount(params: {
    chatId: number;
    userId: number;
    dayKey: string;
    firstName?: string;
    username?: string;
}): Promise<number> {
    const result = await pool.query<{ sticker_count: number }>(
        `
      INSERT INTO daily_usage (chat_id, user_id, day_key, sticker_count, first_name, username, updated_at)
      VALUES ($1, $2, $3, 1, $4, $5, NOW())
      ON CONFLICT (chat_id, user_id, day_key)
      DO UPDATE SET
        sticker_count = daily_usage.sticker_count + 1,
        first_name = EXCLUDED.first_name,
        username = EXCLUDED.username,
        updated_at = NOW()
      RETURNING sticker_count
    `,
        [
            params.chatId,
            params.userId,
            params.dayKey,
            params.firstName ?? null,
            params.username ?? null,
        ],
    );

    return result.rows[0].sticker_count;
}

async function userIsPrivileged(
    chatId: number,
    userId: number,
): Promise<boolean> {
    const member = await bot.telegram.getChatMember(chatId, userId);
    return member.status === "administrator" || member.status === "creator";
}

async function sendLimitNotice(ctx: Context, text: string): Promise<void> {
    if (!ctx.chat) return;
    await ctx.telegram.sendMessage(ctx.chat.id, text, {
        parse_mode: "HTML",
        disable_notification: true,
    });
}

bot.start(async (ctx) => {
    await ctx.reply(
        [
            "Sticker Quota Bot is online.",
            "",
            "Add me to a group, make me an admin, then use:",
            "/setstickerlimit 10",
            "/settimezone Asia/Almaty",
            "/setstickeraction delete",
            "/setstickeraction restrict",
            "/setrestrictminutes 60",
            "/stickerlimit",
            "/mystickers",
            "/leaderboard",
        ].join("\n"),
    );
});

bot.command("help", async (ctx) => {
    await ctx.reply(
        [
            "Commands:",
            "/setstickerlimit <number> — admin only",
            "/settimezone <IANA timezone> — admin only",
            "/setstickeraction <delete|restrict> — admin only",
            "/setrestrictminutes <minutes> — admin only",
            "/stickerlimit — show current settings",
            "/mystickers — show your sticker count for today",
            "/leaderboard — show today's top sticker senders",
        ].join("\n"),
    );
});

bot.command("setstickerlimit", async (ctx) => {
    if (!isGroupChat(ctx) || !ctx.chat) {
        await ctx.reply("Use this command inside a group.");
        return;
    }

    if (!(await isAdmin(ctx))) {
        await ctx.reply("Only group admins can change the sticker limit.");
        return;
    }

    const parts = ctx.message.text.trim().split(/\s+/);
    const limit = Number(parts[1]);

    if (!Number.isInteger(limit) || limit <= 0 || limit > 10000) {
        await ctx.reply("Usage: /setstickerlimit 10");
        return;
    }

    await ensureGroup(
        ctx.chat.id,
        "title" in ctx.chat ? ctx.chat.title : undefined,
    );
    await updateGroupSettings(ctx.chat.id, { sticker_limit: limit });
    await ctx.reply(`Лимит енді тек ${limit} шт күніне.`);
});

bot.command("settimezone", async (ctx) => {
    if (!isGroupChat(ctx) || !ctx.chat) {
        await ctx.reply("Use this command inside a group.");
        return;
    }

    if (!(await isAdmin(ctx))) {
        await ctx.reply("Only group admins can change the timezone.");
        return;
    }

    const parts = ctx.message.text.trim().split(/\s+/);
    const timeZone = parts[1];

    if (!timeZone || !isValidTimeZone(timeZone)) {
        await ctx.reply("Usage: /settimezone Asia/Almaty");
        return;
    }

    await ensureGroup(
        ctx.chat.id,
        "title" in ctx.chat ? ctx.chat.title : undefined,
    );
    await updateGroupSettings(ctx.chat.id, { timezone: timeZone });
    await ctx.reply(`Done. Daily reset timezone is now ${timeZone}.`);
});

bot.command("setstickeraction", async (ctx) => {
    if (!isGroupChat(ctx) || !ctx.chat) {
        await ctx.reply("Use this command inside a group.");
        return;
    }

    if (!(await isAdmin(ctx))) {
        await ctx.reply("Only group admins can change the sticker action.");
        return;
    }

    const parts = ctx.message.text.trim().split(/\s+/);
    const action = parts[1] as StickerAction;

    if (action !== "delete" && action !== "restrict") {
        await ctx.reply(
            "Usage: /setstickeraction delete\nUsage: /setstickeraction restrict",
        );
        return;
    }

    await ensureGroup(
        ctx.chat.id,
        "title" in ctx.chat ? ctx.chat.title : undefined,
    );
    await updateGroupSettings(ctx.chat.id, { action });
    await ctx.reply(`Done. Action is now ${action}.`);
});

bot.command("setrestrictminutes", async (ctx) => {
    if (!isGroupChat(ctx) || !ctx.chat) {
        await ctx.reply("Use this command inside a group.");
        return;
    }

    if (!(await isAdmin(ctx))) {
        await ctx.reply("Only group admins can change the restrict duration.");
        return;
    }

    const parts = ctx.message.text.trim().split(/\s+/);
    const minutes = Number(parts[1]);

    if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 10080) {
        await ctx.reply("Usage: /setrestrictminutes 60");
        return;
    }

    await ensureGroup(
        ctx.chat.id,
        "title" in ctx.chat ? ctx.chat.title : undefined,
    );
    await updateGroupSettings(ctx.chat.id, { restrict_minutes: minutes });
    await ctx.reply(`Done. Restrict duration is now ${minutes} minute(s).`);
});

bot.command("stickerlimit", async (ctx) => {
    if (!isGroupChat(ctx) || !ctx.chat) {
        await ctx.reply("Use this command inside a group.");
        return;
    }

    const settings = await getGroupSettings(ctx.chat.id);
    await ctx.reply(
        [
            `Group: ${settings.title ?? "Unknown"}`,
            `Daily limit: ${settings.sticker_limit}`,
            `Timezone: ${settings.timezone}`,
            `Action: ${settings.action}`,
            `Restrict minutes: ${settings.restrict_minutes}`,
            `Enabled: ${settings.enabled ? "yes" : "no"}`,
        ].join("\n"),
    );
});

bot.command("mystickers", async (ctx) => {
    if (!isGroupChat(ctx) || !ctx.chat || !ctx.from) {
        await ctx.reply("Use this command inside a group.");
        return;
    }

    const settings = await getGroupSettings(ctx.chat.id);
    const dayKey = getDayKey(new Date(), settings.timezone);
    const count = await getUserStickerCount(ctx.chat.id, ctx.from.id, dayKey);

    await ctx.reply(
        `Today you used ${count}/${settings.sticker_limit} stickers in this group.`,
    );
});

bot.command("leaderboard", async (ctx) => {
    if (!isGroupChat(ctx) || !ctx.chat) {
        await ctx.reply("Use this command inside a group.");
        return;
    }

    const settings = await getGroupSettings(ctx.chat.id);
    const dayKey = getDayKey(new Date(), settings.timezone);

    const result = await pool.query<{
        first_name: string | null;
        username: string | null;
        sticker_count: number;
    }>(
        `
      SELECT first_name, username, sticker_count
      FROM daily_usage
      WHERE chat_id = $1 AND day_key = $2
      ORDER BY sticker_count DESC, updated_at ASC
      LIMIT 10
    `,
        [ctx.chat.id, dayKey],
    );

    if (result.rows.length === 0) {
        await ctx.reply(
            "No stickers counted yet today. A peaceful day — suspicious, but peaceful.",
        );
        return;
    }

    const lines = result.rows.map((row, index) => {
        const label = row.username
            ? `@${row.username}`
            : row.first_name || "Unknown user";
        return `${index + 1}. ${label} — ${row.sticker_count}`;
    });

    await ctx.reply(`Today's sticker leaderboard:\n${lines.join("\n")}`);
});

bot.on(message("sticker"), async (ctx) => {
    if (!isGroupChat(ctx) || !ctx.chat || !ctx.from) {
        return;
    }

    await ensureGroup(
        ctx.chat.id,
        "title" in ctx.chat ? ctx.chat.title : undefined,
    );
    const settings = await getGroupSettings(ctx.chat.id);

    if (!settings.enabled) {
        return;
    }

    const messageDate = new Date(
        (ctx.message.date || Math.floor(Date.now() / 1000)) * 1000,
    );
    const dayKey = getDayKey(messageDate, settings.timezone);
    const count = await incrementStickerCount({
        chatId: ctx.chat.id,
        userId: ctx.from.id,
        dayKey,
        firstName: ctx.from.first_name,
        username: ctx.from.username,
    });

    if (count <= settings.sticker_limit) {
        return;
    }

    if (await userIsPrivileged(ctx.chat.id, ctx.from.id)) {
        return;
    }

    const safeName = escapeHtml(ctx.from.first_name || "User");

    if (settings.action === "restrict" && ctx.chat.type === "supergroup") {
        const untilDate =
            Math.floor(Date.now() / 1000) + settings.restrict_minutes * 60;

        await ctx.telegram.restrictChatMember(ctx.chat.id, ctx.from.id, {
            permissions: {
                can_send_messages: true,
                can_send_audios: true,
                can_send_documents: true,
                can_send_photos: true,
                can_send_videos: true,
                can_send_video_notes: true,
                can_send_voice_notes: true,
                can_send_polls: true,
                can_send_other_messages: false,
                can_add_web_page_previews: true,
            },
            use_independent_chat_permissions: true,
            until_date: untilDate,
        });

        if (count === settings.sticker_limit + 1) {
            await sendLimitNotice(
                ctx,
                `<b>${safeName}</b> reached the daily sticker limit (${settings.sticker_limit}) and is blocked from sending stickers for ${settings.restrict_minutes} minute(s).`,
            );
        }

        try {
            await ctx.deleteMessage();
        } catch {
            // Ignore deletion failures.
        }

        return;
    }

    try {
        await ctx.deleteMessage();
    } catch {
        // Ignore deletion failures.
    }

    if (count === settings.sticker_limit + 1) {
        await sendLimitNotice(
            ctx,
            `<b>${safeName}</b> reached the daily sticker limit (${settings.sticker_limit}). Extra stickers will be deleted until the next reset.`,
        );
    }
});

bot.catch((error, ctx) => {
    console.error("Bot error:", error);
    if (ctx.chat) {
        void ctx.reply("Something went wrong. Check the logs and permissions.");
    }
});

async function main(): Promise<void> {
    await initDb();

    const app = express();
    app.get("/", (_req, res) => {
        res.status(200).send("Sticker Quota Bot is running");
    });

    app.listen(PORT, "0.0.0.0", () => {
        console.log(`Health server listening on ${PORT}`);
    });

    await bot.telegram.deleteWebhook({ drop_pending_updates: false });
    await bot.launch();
    console.log("Bot launched with long polling");
}

void main();

process.once("SIGINT", () => {
    bot.stop("SIGINT");
    void pool.end();
});

process.once("SIGTERM", () => {
    bot.stop("SIGTERM");
    void pool.end();
});
