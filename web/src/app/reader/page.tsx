"use client";
import { useEffect } from "react";
export default function ReaderPage() {
  useEffect(() => { window.location.href = "/search"; }, []);
  return null;
}
