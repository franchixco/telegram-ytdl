import type { ytDlpInfo } from "@resync-tv/yt-dlp";

export const findBestVideoFormat = (formats: ytDlpInfo.Format[]): ytDlpInfo.Format | undefined => {
  const videoFormats = formats.filter(f => f.vcodec !== 'none' && f.acodec !== 'none');

  const h264Formats = videoFormats.filter(f => f.vcodec?.includes('h264') || f.vcodec?.startsWith('avc'));

  if (h264Formats.length > 0) {
    // Sort by height and return the best one
    return h264Formats.sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0];
  }

  // Fallback to any video format
  return videoFormats.sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0];
};

export const findBestAudioFormat = (formats: ytDlpInfo.Format[]): ytDlpInfo.Format | undefined => {
  const audioFormats = formats.filter(f => f.vcodec === 'none' && f.acodec !== 'none');

  const preferredFormat = audioFormats.find(f => f.ext === 'm4a');
  if (preferredFormat) return preferredFormat;

  // Fallback to the best available audio format
  return audioFormats.sort((a, b) => (b.abr ?? 0) - (a.abr ?? 0))[0];
};
