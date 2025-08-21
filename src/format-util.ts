import type { ytDlpInfo } from "@resync-tv/yt-dlp";

export const findVideoFormat = (formats: ytDlpInfo.Format[], height: number): ytDlpInfo.Format | undefined => {
  const videoFormats = formats.filter(f => f.vcodec !== 'none' && f.acodec !== 'none');

  const preferredFormats = videoFormats.filter(f =>
    f.ext === 'mp4' && f.vcodec?.startsWith('avc')
  );

  if (preferredFormats.length > 0) {
    const format = preferredFormats.find(f => f.height === height);
    if (format) return format;
  }

  // Fallback to any format with the given height
  return videoFormats.find(f => f.height === height);
};

export const findBestAudioFormat = (formats: ytDlpInfo.Format[]): ytDlpInfo.Format | undefined => {
  const audioFormats = formats.filter(f => f.vcodec === 'none' && f.acodec !== 'none');

  const preferredFormat = audioFormats.find(f => f.ext === 'm4a');
  if (preferredFormat) return preferredFormat;

  // Fallback to the best available audio format
  return audioFormats.sort((a, b) => (b.abr ?? 0) - (a.abr ?? 0))[0];
};