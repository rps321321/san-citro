"use client";

import { motion, useReducedMotion } from "framer-motion";
import React, {
  type ComponentPropsWithoutRef,
  useEffect,
  useRef,
  useState,
} from "react";

import { cn } from "@/lib/utils";

const inputWrapperClassName = cn(
  "bg-muted2  has-[:focus-visible]:outline-muted3 relative w-full max-w-[420px] rounded-2xl p-4",
  "has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2",
);

const inputClassName =
  "w-full bg-transparent outline-none placeholder:text-foreground/40";

type InputFieldProps = ComponentPropsWithoutRef<"input"> & {
  wrapperClassName?: string;
};

const Input = ({ className, wrapperClassName, ...props }: InputFieldProps) => {
  return (
    <div className={cn(inputWrapperClassName, wrapperClassName)}>
      <input className={cn(inputClassName, className)} {...props} />
    </div>
  );
};

const SmoothInput = ({
  className,
  wrapperClassName,
  value,
  defaultValue,
  onChange,
  ...props
}: InputFieldProps) => {
  const [internalValue, setInternalValue] = useState(defaultValue ?? "");
  const [caretX, setCaretX] = useState(0);
  const [caretOpacity, setCaretOpacity] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const caretRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const prefersReducedMotion = useReducedMotion();

  const isControlled = value !== undefined;
  const inputValue = isControlled ? String(value) : internalValue;

  useEffect(() => {
    if (!canvasRef.current) {
      const canvas = document.createElement("canvas");
      canvas.style.display = "none";
      document.body.appendChild(canvas);
      canvasRef.current = canvas;
    }

    const input = inputRef.current;
    const caret = caretRef.current;
    const container = containerRef.current;
    const canvas = canvasRef.current;

    if (!input || !caret || !container || !canvas) return;

    const getComputedStyle = (element: HTMLElement, property: string) => {
      return window.getComputedStyle(element, null).getPropertyValue(property);
    };

    const getTextWidth = (text: string, font: string) => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return 0;
      ctx.font = font;
      return ctx.measureText(text).width;
    };

    const passwordChar = navigator.userAgent.match(/firefox|fxios/i)
      ? "\u25CF"
      : "\u2022";

    const fontSize = getComputedStyle(input, "font-size");
    const fontFamily = getComputedStyle(input, "font-family");
    const isPassword = input.type === "password";
    const font =
      passwordChar === "\u2022" &&
      isPassword &&
      !navigator.userAgent.match(/chrome|chromium|crios/i)
        ? `${parseFloat(fontSize) + 6.25}px ${fontFamily}`
        : `${fontSize} ${fontFamily}`;

    const paddingLeft = parseInt(getComputedStyle(input, "padding-left")) || 0;
    const letterSpacing =
      parseInt(getComputedStyle(input, "letter-spacing")) || 0;
    const caretWidth = 2;
    const maxMargin = (container.offsetWidth || 0) - 10;
    const caretMargin = paddingLeft + 2;

    const computedLineHeight = getComputedStyle(input, "line-height");
    const fontSizeNum = parseFloat(fontSize);
    let caretHeight: number;

    if (computedLineHeight === "normal") {
      caretHeight = fontSizeNum * 1.2;
    } else if (computedLineHeight.endsWith("px")) {
      caretHeight = parseFloat(computedLineHeight) * 0.9;
    } else if (!isNaN(parseFloat(computedLineHeight))) {
      caretHeight = fontSizeNum * parseFloat(computedLineHeight) * 0.9;
    } else {
      caretHeight = fontSizeNum * 1.2;
    }

    caretHeight = Math.max(caretHeight, fontSizeNum);

    caret.style.width = "2px";
    caret.style.height = `${caretHeight}px`;
    caret.style.pointerEvents = "none";

    const pwRatio = isPassword
      ? getTextWidth(passwordChar + passwordChar, font) -
        getTextWidth(passwordChar, font)
      : null;

    const updateCaret = (text: string) => {
      if (!caret) return;

      const displayText = isPassword
        ? Array(text.length + 1).join(passwordChar)
        : text;

      let textWidth: number;
      if (pwRatio && isPassword) {
        textWidth =
          pwRatio * displayText.length +
          caretMargin +
          letterSpacing * (displayText.length - 1);
      } else {
        const measuredWidth = getTextWidth(displayText, font);
        textWidth =
          measuredWidth > 0
            ? measuredWidth +
              caretMargin +
              letterSpacing * (displayText.length - 1)
            : caretMargin - caretWidth / 2;
      }

      if (textWidth <= maxMargin) {
        setCaretOpacity(1);
        setCaretX(textWidth);
      }
    };

    const handleInput = (e: Event) => {
      const target = e.target as HTMLInputElement;
      setTimeout(() => {
        const selectionStart = target.selectionStart || 0;
        const textBeforeCaret = isPassword
          ? Array(selectionStart + 1).join(passwordChar)
          : target.value.slice(0, selectionStart);
        updateCaret(textBeforeCaret);
      }, 0);
    };

    const handleBlur = () => {
      setCaretOpacity(0);
    };

    const handleFocus = () => {
      if (input && caret) {
        const selectionStart = input.selectionStart || 0;
        const textBeforeCaret = isPassword
          ? Array(selectionStart + 1).join(passwordChar)
          : input.value.slice(0, selectionStart);
        updateCaret(textBeforeCaret);
      }
    };

    const updateCaretPosition = () => {
      if (document.activeElement === input && input) {
        const selectionStart = input.selectionStart || 0;
        const textBeforeCaret = isPassword
          ? Array(selectionStart + 1).join(passwordChar)
          : input.value.slice(0, selectionStart);
        updateCaret(textBeforeCaret);
      }
    };

    input.addEventListener("input", handleInput);
    input.addEventListener("blur", handleBlur);
    input.addEventListener("focus", handleFocus);
    input.addEventListener("keyup", updateCaretPosition);
    input.addEventListener("click", updateCaretPosition);

    if (document.activeElement === input) {
      const selectionStart = input.selectionStart || input.value.length;
      const textBeforeCaret = isPassword
        ? Array(selectionStart + 1).join(passwordChar)
        : input.value.slice(0, selectionStart);
      updateCaret(textBeforeCaret);
    }

    const intervalId = setInterval(updateCaretPosition, 50);

    return () => {
      input.removeEventListener("input", handleInput);
      input.removeEventListener("blur", handleBlur);
      input.removeEventListener("focus", handleFocus);
      input.removeEventListener("keyup", updateCaretPosition);
      input.removeEventListener("click", updateCaretPosition);
      clearInterval(intervalId);
    };
  }, [inputValue]);

  useEffect(() => {
    return () => {
      canvasRef.current?.remove();
      canvasRef.current = null;
    };
  }, []);

  return (
    <div className={cn(inputWrapperClassName, wrapperClassName)}>
      <div
        ref={containerRef}
        className="relative grid grid-cols-1 p-0"
        style={{ caretColor: "transparent" }}
      >
        <input
          ref={inputRef}
          className={cn(
            inputClassName,
            "col-start-1 col-end-2 row-start-1 row-end-2",
            className,
          )}
          value={inputValue}
          onChange={(e) => {
            if (!isControlled) setInternalValue(e.target.value);
            onChange?.(e);
          }}
          {...props}
        />
        <motion.div
          ref={caretRef}
          className="bg-primary col-start-1 col-end-2 row-start-1 row-end-2 self-center"
          animate={{
            x: caretX,
            opacity: caretOpacity,
          }}
          transition={
            prefersReducedMotion
              ? { duration: 0 }
              : {
                  type: "spring",
                  stiffness: 500,
                  damping: 30,
                  mass: 0.5,
                }
          }
        />
      </div>
    </div>
  );
};

const Skiper106 = () => {
  return (
    <div className="bg-muted text-foreground flex h-full w-full flex-col items-center justify-center">
      <div className="-mt-10 mb-20 grid content-start justify-items-center gap-6 text-center">
        <span className="after:bg-linear-to-b after:to-foreground relative max-w-[12ch] text-xs uppercase leading-tight opacity-40 after:absolute after:left-1/2 after:top-full after:h-16 after:w-px after:from-transparent after:content-['']">
          Try typing below
        </span>
      </div>
      <div className="flex w-full flex-col items-center space-y-4 text-2xl">
        <SmoothInput
          placeholder="smooth input"
          aria-label="Smooth caret input"
        />
        <Input placeholder="normal input" className="caret-primary" aria-label="Normal input" />
      </div>
    </div>
  );
};

export { Input, Skiper106, SmoothInput };
