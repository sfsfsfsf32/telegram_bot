import { Telegraf, Markup } from "telegraf";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import os from "os";
import { logger } from "./lib/logger";

const execAsync = promisify(exec);

if (!process.env.TELEGRAM_BOT_TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN must be set.");
}

export const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

const searchMode = new Set<number>();
const trackedMessages = new Map<number, number[]>();

function isGroup(ctx: any): boolean {
  return ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
}

function track(chatId: number, messageId: number) {
  const list = trackedMessages.get(chatId) ?? [];
  list.push(messageId);
  trackedMessages.set(chatId, list);
}

async function clearTracked(ctx: any, chatId: number) {
  const list = trackedMessages.get(chatId) ?? [];
  trackedMessages.set(chatId, []);
  await Promise.all(
    list.map((id) => ctx.telegram.deleteMessage(chatId, id).catch(() => {}))
  );
}

const mainKeyboard = Markup.keyboard([
  ["🔍 Поиск музыки по названию"],
]).resize();

const welcomeTextPrivate =
  `👋 Привет! Я бот для скачивания аудио с YouTube.\n\n` +
  `🔗 Отправь ссылку на YouTube — получи MP3.\n` +
  `🔍 Нажми «Поиск музыки» — найду трек по названию. 🎧`;

const welcomeTextGroup =
  `👋 Привет! Я бот для скачивания аудио с YouTube.\n\n` +
  `🔗 Отправь ссылку на YouTube — получу MP3.\n` +
  `🔍 Напиши /search название трека — найду по названию.`;

function isYouTubeUrl(url: string): boolean {
  return /(?:youtube\.com|youtu\.be)/i.test(url);
}

async function downloadAndSend(
  ctx: any,
  target: string,
  statusText: string,
  group: boolean
) {
  const statusMsg = await ctx.reply(statusText);
  if (!group) track(ctx.chat.id, statusMsg.message_id);

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ytdlp-"));
  const outputTemplate = path.join(tmpDir, "audio.%(ext)s");
  const outputMp3 = path.join(tmpDir, "audio.mp3");

  try {
    const ytDlpPath = (await execAsync("which yt-dlp")).stdout.trim();
    const ffmpegPath = (await execAsync("which ffmpeg")).stdout.trim();

    const cmd = [
      ytDlpPath,
      "--no-playlist",
      "--extract-audio",
      "--audio-format", "mp3",
      "--audio-quality", "0",
      "--write-info-json",
      "--write-thumbnail",
      "--convert-thumbnails", "jpg",
      "--ffmpeg-location", path.dirname(ffmpegPath),
      "-o", `"${outputTemplate}"`,
      `"${target}"`,
    ].join(" ");

    logger.info({ target }, "Starting yt-dlp");
    await execAsync(cmd, { timeout: 5 * 60 * 1000 });

    if (!fs.existsSync(outputMp3)) {
      throw new Error("MP3 file was not created after download.");
    }

    const stat = await fs.promises.stat(outputMp3);
    const fileSizeMb = stat.size / (1024 * 1024);

    if (fileSizeMb > 50) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        undefined,
        "❌ Файл слишком большой (больше 50 МБ) для отправки в Telegram."
      );
      return;
    }

    const infoJsonPath = path.join(tmpDir, "audio.info.json");
    const thumbPath = path.join(tmpDir, "audio.jpg");

    let title: string | undefined;
    if (fs.existsSync(infoJsonPath)) {
      try {
        const info = JSON.parse(
          await fs.promises.readFile(infoJsonPath, "utf-8")
        );
        title = info.title ?? undefined;
      } catch {}
    }

    const hasThumb = fs.existsSync(thumbPath);

    logger.info({ target, fileSizeMb: fileSizeMb.toFixed(2), title }, "Sending audio");

    await ctx.replyWithAudio(
      { source: outputMp3 },
      {
        title,
        ...(hasThumb ? { thumbnail: { source: thumbPath } } : {}),
      }
    );

    if (group) {
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    } else {
      await clearTracked(ctx, ctx.chat.id);
    }
  } catch (err) {
    logger.error({ err, target }, "Error downloading audio");
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      "❌ Что-то пошло не так 😢"
    );
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
}

bot.start(async (ctx) => {
  const group = isGroup(ctx);
  searchMode.delete(ctx.from.id);

  if (group) {
    await ctx.reply(welcomeTextGroup);
  } else {
    await clearTracked(ctx, ctx.chat.id);
    const sent = await ctx.reply(welcomeTextPrivate, mainKeyboard);
    track(ctx.chat.id, sent.message_id);
  }
});

bot.command("search", async (ctx) => {
  const group = isGroup(ctx);
  const query = ctx.message.text.replace(/^\/search\s*/i, "").trim();

  if (!query) {
    const sent = await ctx.reply("🔍 Укажи название после команды: /search Название трека");
    if (group) {
      setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, sent.message_id).catch(() => {}), 5000);
    } else {
      track(ctx.chat.id, sent.message_id);
    }
    return;
  }

  if (!group) {
    await ctx.deleteMessage(ctx.message.message_id).catch(() => {});
    await clearTracked(ctx, ctx.chat.id);
  }

  await downloadAndSend(ctx, `ytsearch1:${query}`, `🔍 Ищу «${query}»...`, group);
});

bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  const group = isGroup(ctx);

  if (group) {
    if (isYouTubeUrl(text)) {
      await downloadAndSend(ctx, text, "⏳ Скачиваю...", true);
    }
    return;
  }

  await ctx.deleteMessage(ctx.message.message_id).catch(() => {});

  if (text === "🔍 Поиск музыки по названию") {
    searchMode.add(userId);
    await clearTracked(ctx, chatId);
    const sent = await ctx.reply(
      "🔍 Введи название трека или исполнителя:",
      Markup.keyboard([["❌ Отмена"]]).resize()
    );
    track(chatId, sent.message_id);
    return;
  }

  if (text === "❌ Отмена") {
    searchMode.delete(userId);
    await clearTracked(ctx, chatId);
    const sent = await ctx.reply("Отменено.", mainKeyboard);
    track(chatId, sent.message_id);
    return;
  }

  if (searchMode.has(userId)) {
    searchMode.delete(userId);
    await clearTracked(ctx, chatId);
    await downloadAndSend(ctx, `ytsearch1:${text}`, `🔍 Ищу «${text}»...`, false);
    return;
  }

  if (!isYouTubeUrl(text)) {
    await clearTracked(ctx, chatId);
    const sent = await ctx.reply(
      "Отправь ссылку на YouTube или нажми «🔍 Поиск музыки по названию».",
      mainKeyboard
    );
    track(chatId, sent.message_id);
    return;
  }

  await clearTracked(ctx, chatId);
  await downloadAndSend(ctx, text, "⏳ Скачиваю...", false);
});

bot.catch((err) => {
  logger.error({ err }, "Unhandled bot error");
});
