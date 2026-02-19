export function Footer() {
  return (
    <footer className="border-t border-blacklight-border py-8 text-center text-sm text-blacklight-text-muted">
      <div className="mx-auto max-w-5xl px-6">
        <p>
          Blacklight Pool &mdash; Community staking for{" "}
          <a
            href="https://blacklight.nillion.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blacklight-accent transition-colors hover:text-blacklight-accent-hover"
          >
            Nillion Blacklight
          </a>
        </p>
      </div>
    </footer>
  );
}
