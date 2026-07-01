"use client";

export function openReader(md5: string, title: string, filename: string) {
  sessionStorage.setItem("reader:md5", md5);
  sessionStorage.setItem("reader:title", title);
  sessionStorage.setItem("reader:filename", filename);
  if (window.location.hash === "#/reader") window.location.reload();
  else window.location.hash = "#/reader";
}
