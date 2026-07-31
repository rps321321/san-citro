"use client";

export interface ReaderSession {
  md5: string | null;
  title: string;
  filename: string;
}

/** Read the open-reader handoff from sessionStorage (single ownership boundary). */
export function readReaderSession(): ReaderSession {
  if (typeof window === "undefined") {
    return { md5: null, title: "", filename: "" };
  }
  try {
    return {
      md5: sessionStorage.getItem("reader:md5"),
      title: sessionStorage.getItem("reader:title") ?? "",
      filename: sessionStorage.getItem("reader:filename") ?? "",
    };
  } catch {
    return { md5: null, title: "", filename: "" };
  }
}

export function openReader(md5: string, title: string, filename: string) {
  sessionStorage.setItem("reader:md5", md5);
  sessionStorage.setItem("reader:title", title);
  sessionStorage.setItem("reader:filename", filename);
  if (window.location.hash === "#/reader") window.location.reload();
  else window.location.hash = "#/reader";
}
