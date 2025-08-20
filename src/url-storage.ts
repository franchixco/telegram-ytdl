import crypto from "node:crypto";

const urlStorage = new Map<string, string>();

export const storeUrl = (url: string): string => {
  const id = crypto.randomUUID();
  urlStorage.set(id, url);
  return id;
};

export const getUrl = (id: string): string | undefined => {
  return urlStorage.get(id);
};
