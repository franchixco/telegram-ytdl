import type { ytDlpInfo } from "@resync-tv/yt-dlp";

export const findBestVideoFormat = (formats: ytDlpInfo.Format[]): ytDlpInfo.Format | undefined => {
  const videoFormats = formats.filter(f => f.vcodec !== 'none' && f.acodec !== 'none');

  const preferredFormats = videoFormats.filter(f =>
    f.ext === 'mp4' && f.vcodec?.startsWith('avc')
  );

  if (preferredFormats.length > 0) {
    const format1080 = preferredFormats.find(f => f.height === 1080);
    if (format1080) return format1080;

    const format720 = preferredFormats.find(f => f.height === 720);
    if (format720) return format720;
  }

  // Fallback to any 1080p or 720p format
  const format1080 = videoFormats.find(f => f.height === 1080);
  if (format1080) return format1080;

  const format720 = videoFormats.find(f => f.height === 720);
  if (format720) return format720;

  // Fallback to the best available format
  return videoFormats.sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0];
};

export const findBestAudioFormat = (formats: ytDlpInfo.Format[]): ytDlpInfo.Format | undefined => {
  const audioFormats = formats.filter(f => f.vcodec === 'none' && f.acodec !== 'none');

  const preferredFormat = audioFormats.find(f => f.ext === 'm4a');
  if (preferredFormat) return preferredFormat;

  // Fallback to the best available audio format
  return audioFormats.sort((a, b) => (b.abr ?? 0) - (a.abr ?? 0))[0];
};
