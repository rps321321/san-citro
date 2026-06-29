// The player view loads under the minimal root layout (html/body/theme) only —
// no app sidebar/header. This pass-through layout keeps the /player route group
// free of the (app) chrome without introducing a second root layout.
export default function PlayerLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // h-dvh establishes a definite height so the player page's `h-full` fills the
  // entire view. The root <body> is only `min-h-full`, against which a child
  // `h-full` collapses to content height — which left a transparent gap at the
  // bottom of the (correctly full-height) view.
  return <div className="h-dvh w-full">{children}</div>;
}
