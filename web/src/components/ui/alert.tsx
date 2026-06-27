import type * as React from "react"
import {
  XIcon,
  AlertCircleIcon,
  CheckCircle2Icon,
  AlertTriangleIcon,
  InfoIcon,
  type LucideIcon,
} from "lucide-react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

const bannerVariants = cva(
  "flex items-start gap-2.5 rounded-lg border p-3 text-sm [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        error:
          "border-destructive/30 bg-destructive/10 text-destructive [&>svg]:text-destructive",
        success:
          "border-success/30 bg-success/10 text-success [&>svg]:text-success",
        warning:
          "border-warning/30 bg-warning/10 text-warning [&>svg]:text-warning",
        info: "border-info/30 bg-info/10 text-info [&>svg]:text-info",
      },
    },
    defaultVariants: {
      variant: "info",
    },
  }
)

const VARIANT_ICONS: Record<NonNullable<BannerVariant>, LucideIcon> = {
  error: AlertCircleIcon,
  success: CheckCircle2Icon,
  warning: AlertTriangleIcon,
  info: InfoIcon,
}

type BannerVariant = VariantProps<typeof bannerVariants>["variant"]

function Banner({
  variant = "info",
  message,
  children,
  onDismiss,
  className,
}: {
  variant?: BannerVariant
  message?: string
  children?: React.ReactNode
  onDismiss?: () => void
  className?: string
}) {
  const resolved = variant ?? "info"
  const Icon = VARIANT_ICONS[resolved]
  // error/warning are assertive; success/info are polite status updates.
  const role = resolved === "error" || resolved === "warning" ? "alert" : "status"

  return (
    <div role={role} className={cn(bannerVariants({ variant }), className)}>
      <Icon aria-hidden="true" />
      <div className="flex-1 leading-snug">{children ?? message}</div>
      {onDismiss && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="-my-1 -mr-1 shrink-0 text-current hover:text-current"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          <XIcon />
        </Button>
      )}
    </div>
  )
}

export { Banner, bannerVariants }
