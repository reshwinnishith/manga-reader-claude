import Link from "next/link";

export default function NotFound() {
  return (
    <div className="fullpage">
      <h1 className="page-title">Not found</h1>
      <p className="muted">That series or chapter doesn&apos;t exist.</p>
      <Link href="/" className="btn btn--primary">Go home</Link>
    </div>
  );
}
