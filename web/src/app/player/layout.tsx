// The player view loads under the minimal root layout (html/body/theme) only —
// no app sidebar/header. This pass-through layout keeps the /player route group
// free of the (app) chrome without introducing a second root layout.
export default function PlayerLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <>{children}</>;
}
