import { downloadFromInfo, getInfo, type ytDlpInfo } from "@resync-tv/yt-dlp";
import { execa } from "execa";
import { InputFile } from "grammy";
import { deleteMessage, errorMessage } from "./bot-util"
import { cobaltMatcher, cobaltResolver } from "./cobalt"
import { link, t, tiktokArgs } from "./constants"
import {
	ADMIN_ID,
	ALLOW_GROUPS,
	cookieArgs,
	WHITELISTED_IDS,
} from "./environment"
import { getThumbnail, urlMatcher } from "./media-util"
import { Queue } from "./queue"
import { bot } from "./setup"
import { translateText } from "./translate"
import { Updater } from "./updater"
import { chunkArray, removeHashtagsMentions } from "./util"
import { getUrl, storeUrl } from "./url-storage"
import { findVideoFormat, findBestAudioFormat } from "./format-util"

const queue = new Queue()
const updater = new Updater()

// group & private chat middleware
bot.use(async (ctx, next) => {
	if (ctx.chat?.type === "private") {
		return await next()
	}

	const isGroup = ["supergroup", "group"].includes(ctx.chat?.type ?? "")
	if (ALLOW_GROUPS && isGroup) {
		return await next()
	}
})

// whitelist middleware
bot.use(async (ctx, next) => {
	if (WHITELISTED_IDS.length === 0) {
		return await next();
	}

	const fromId = ctx.from?.id;
	if (fromId && WHITELISTED_IDS.includes(fromId)) {
		return await next();
	}

	// deny access
	const deniedResponse = await ctx.replyWithHTML(t.deniedMessage, {
		link_preview_options: { is_disabled: true },
	});

	await Promise.all([
		(async () => {
			if (ctx.from?.language_code && ctx.from.language_code !== "en") {
				const translated = await translateText(
					t.deniedMessage,
					ctx.from.language_code,
				);
				if (translated === t.deniedMessage) return;
				if (ctx.chat) {
					await bot.api.editMessageText(
						ctx.chat.id,
						deniedResponse.message_id,
						translated,
						{ parse_mode: "HTML", link_preview_options: { is_disabled: true } },
					);
				}
			}
		})(),
		(async () => {
			if (ctx.chat?.id) {
				const forwarded = await ctx.forwardMessage(ADMIN_ID, {
					disable_notification: true,
				});
				await bot.api.setMessageReaction(
					forwarded.chat.id,
					forwarded.message_id,
					[{ type: "emoji", emoji: "🖕" }],
				);
			}
		})(),
	]);
});


bot.command("version", async (ctx) => {
	try {
		const { stdout: version } = await execa("yt-dlp", ["--version"]);
		await ctx.replyWithHTML(`yt-dlp version: <code>${version}</code>`);
	} catch (error) {
		console.error(error);
		if (ctx.chat) await errorMessage(ctx.chat, "Failed to get yt-dlp version.");
	}
});

bot.command("update", async (ctx) => {
	const updateMessage = await ctx.replyWithHTML("⏳ Actualizando yt-dlp...");
	try {
		const newVersion = await updater.update();
		if (ctx.chat && newVersion) {
			await bot.api.editMessageText(
				ctx.chat.id,
				updateMessage.message_id,
				`✅ yt-dlp actualizado a la versión: <code>${newVersion}</code>`
			);
		}
	} catch (error) {
		console.error(error);
		if (ctx.chat) {
			await bot.api.editMessageText(
				ctx.chat.id,
				updateMessage.message_id,
				"❌ Error al actualizar yt-dlp."
			);
			await errorMessage(ctx.chat, error?.toString());
		}
	}
});


bot.on("message:text", async (ctx) => {
	// Maintenance notice
	if (updater.updating) {
		const maintenanceNotice = await ctx.replyWithHTML(t.maintenanceNotice);
		await updater.updating;
		await deleteMessage(maintenanceNotice);
	}

	const urlEntity = ctx.message?.entities?.find((e) => e.type === "url");
	if (!urlEntity) {
		const response = await ctx.replyWithHTML(t.urlReminder);

		if (ctx.from.language_code && ctx.from.language_code !== "en") {
			const translated = await translateText(
				t.urlReminder,
				ctx.from.language_code,
			)
			if (translated === t.urlReminder) return
			await bot.api.editMessageText(
				ctx.chat.id,
				response.message_id,
				translated,
				{ parse_mode: "HTML", link_preview_options: { is_disabled: true } },
			)
		}
		return;
	}

	const url = ctx.message?.text?.substring(urlEntity.offset, urlEntity.offset + urlEntity.length);
	if (!url) return;

	const processingMessage = await ctx.replyWithHTML(t.processing, {
		disable_notification: true,
	});

	if (ctx.chat.id !== ADMIN_ID) {
		ctx
			.forwardMessage(ADMIN_ID, { disable_notification: true })
			.then(async (forwarded) => {
				await bot.api.setMessageReaction(
					forwarded.chat.id,
					forwarded.message_id,
					[{ type: "emoji", emoji: "🤝" }],
				);
			});
	}


	const useCobalt = cobaltMatcher(url)
	const useCobaltResolver = async () => {
		try {
			const resolved = await cobaltResolver(url)

			if (resolved.status === "error") {
				throw new Error(resolved.error.code)
			}

			if (resolved.status === "picker") {
				const photos = chunkArray(
					10,
					resolved.picker
						.filter((p) => p.type === "photo")
						.map((p) => ({
							type: "photo" as const,
							media: p.url,
						})),
				)

				for (const chunk of photos) {
					await bot.api.sendMediaGroup(ctx.chat.id, chunk)
				}

				return true
			}

			if (resolved.status === "redirect") {
				await ctx.replyWithHTML(link("Resolved content URL", resolved.url))
				return true
			}
		} catch (error) {
			console.error("Error resolving with cobalt", error)
		}
	}

	queue.add(async () => {
		try {
			const isTiktok = urlMatcher(url, "tiktok.com")
			const isYouTubeMusic = urlMatcher(url, "music.youtube.com")
			const additionalArgs = isTiktok ? tiktokArgs : []

			if (useCobalt) {
				if (await useCobaltResolver()) return;
			}

			const info = await getInfo(url, [
				"--no-playlist",
				...(await cookieArgs()),
				...additionalArgs,
			])

			const title = removeHashtagsMentions(info.title ?? "")

			const formats = info.formats ?? [];
			const format1080 = findVideoFormat(formats, 1080);
			const format720 = findVideoFormat(formats, 720);
			const bestAudio = findBestAudioFormat(formats);
			const audioFormats = info.formats?.filter((f) => f.acodec !== "none" && f.vcodec === "none") ?? []

			if (format1080 || format720 || bestAudio) {
				const urlId = storeUrl(url);
				const buttons = [];
				if (format1080) {
					buttons.push({
						text: `Video 1080p`,
						callback_data: `format:${format1080.format_id}:${urlId}`,
					});
				}
				if (format720) {
					buttons.push({
						text: `Video 720p`,
						callback_data: `format:${format720.format_id}:${urlId}`,
					});
				}
				if (bestAudio) {
					buttons.push({
						text: `Audio (${bestAudio.ext})`,
						callback_data: `audio:${bestAudio.format_id}:${urlId}`,
					});
				}

				const keyboard = [buttons]

				await ctx.replyWithHTML(title ?? "", {
					reply_markup: { inline_keyboard: keyboard },
					reply_parameters: ctx.message
						? {
								message_id: ctx.message.message_id,
								allow_sending_without_reply: true,
							}
						: undefined,
				})
			} else if (audioFormats.length > 0) {
				const stream = downloadFromInfo(info, "-", [
					"-f",
					audioFormats[0]?.format_id ?? "",
					"-x",
					"--audio-format",
					"mp3",
				])
				const audio = new InputFile(stream.stdout)

				await ctx.replyWithAudio(audio, {
					caption: title,
					performer: info.uploader ?? "",
					title: info.title ?? "",
					thumbnail: getThumbnail(info.thumbnails),
					duration: info.duration ?? 0,
					reply_parameters: ctx.message
						? {
								message_id: ctx.message.message_id,
								allow_sending_without_reply: true,
							}
						: undefined,
				})
			} else {
				if (ctx.chat) await errorMessage(ctx.chat, "No download available")
			}
		} catch (error) {
			if (useCobalt && (await useCobaltResolver())) return;
			if (ctx.chat) {
				return error instanceof Error
					? errorMessage(ctx.chat, error.message)
					: errorMessage(ctx.chat, `Couldn't download ${url}`);
			}
		} finally {
			await deleteMessage(processingMessage)
		}
	})
})

bot.on("callback_query:data", async (ctx) => {
	await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });

	const [type, formatId, urlId] = ctx.callbackQuery.data.split(":");

	if (!urlId) {
		if (ctx.chat) await errorMessage(ctx.chat, "Invalid video ID");
		return;
	}

	const url = getUrl(urlId);

	if (!url) {
		if (ctx.chat) await errorMessage(ctx.chat, "URL not found");
		return;
	}

	const processingMessage = await ctx.replyWithHTML(t.processing, {
		disable_notification: true,
	})

	queue.add(async () => {
		try {
			if (ctx.chat) {
				await bot.api.editMessageText(
					ctx.chat.id,
					processingMessage.message_id,
					"✅ Opción seleccionada. Obteniendo información..."
				);
			}

			const info = await getInfo(url, [
				"--no-playlist",
				...(await cookieArgs()),
			])

			const title = removeHashtagsMentions(info.title ?? "")

			let lastPercentage = -1;
			const updateProgress = async (percentage: number) => {
				if (percentage > lastPercentage) {
					lastPercentage = percentage;
					if (ctx.chat) {
						await bot.api.editMessageText(
							ctx.chat.id,
							processingMessage.message_id,
							`📥 Descargando... ${percentage}%`
						).catch(console.error);
					}
				}
			};

			const downloadStream = (args: string[]) => {
				const stream = downloadFromInfo(info, "-", args);
				stream.stderr?.on("data", (data) => {
					const text = data.toString();
					const match = text.match(/\[download\]\s+([0-9.]+)%/);
					if (match) {
						const percentage = Math.floor(parseFloat(match[1]));
						if (percentage % 5 === 0 || percentage === 100) {
							updateProgress(percentage);
						}
					}
				});
				stream.stderr?.on("end", async () => {
					if (ctx.chat) {
						await bot.api.editMessageText(
							ctx.chat.id,
							processingMessage.message_id,
							'📤 Subiendo a Telegram...'
						).catch(console.error);
					}
				});
				return stream.stdout;
			};

			if (type === "format") {
				if (!formatId) throw new Error("Invalid format ID")
				const videoStream = downloadStream([
					"-f",
					formatId,
					"--concurrent-fragments",
					"10",
					"--write-thumbnail",
				]);
				const video = new InputFile(videoStream, title)

				await ctx.replyWithVideo(video, {
					caption: title,
					supports_streaming: true,
					duration: info.duration ?? 0,
					reply_parameters: {
						message_id: ctx.callbackQuery.message?.message_id ?? 0,
						allow_sending_without_reply: true,
					},
				})
			} else if (type === "audio") {
				const audioStream = downloadStream([
					"-f",
					formatId ?? "",
					"--concurrent-fragments",
					"10",
					"-x",
					"--audio-format",
					"mp3",
				]);
				const audio = new InputFile(audioStream)

				await ctx.replyWithAudio(audio, {
					caption: title,
					performer: info.uploader ?? "",
					title: info.title ?? "",
					thumbnail: getThumbnail(info.thumbnails),
					duration: info.duration ?? 0,
					reply_parameters: {
						message_id: ctx.callbackQuery.message?.message_id ?? 0,
						allow_sending_without_reply: true,
					},
				})
			}
		} catch (error) {
			console.error(error)
			if (ctx.chat) await errorMessage(ctx.chat, error?.toString())
		} finally {
			await deleteMessage(processingMessage)
		}
	})
})

bot.catch((error) => {
	console.error("Error in bot", error);
});

// bot.start();