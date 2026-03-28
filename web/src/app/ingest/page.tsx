"use client";
import { useEffect } from "react";

export default function IngestPage() {
  useEffect(() => {
    window.location.href = "/search";
  }, []);
  return null;
}
