// Decorative product artwork, like the ticket illustration on Geiger Events.
export default function HeroPods() {
  return <div className="relative isolate mx-auto w-full max-w-[320px]" aria-hidden="true">
    <svg viewBox="0 0 520 460" fill="none" className="block w-full overflow-visible">
      <ellipse cx="260" cy="356" rx="154" ry="38" className="fill-foreground opacity-[.045] blur-[13px]" />
      <g strokeWidth="2" className="stroke-border">
        <path d="M260 204V106Q260 82 284 82H390" />
        <path d="M173 243H110Q86 243 86 219V114" />
        <path d="M345 263H424Q448 263 448 287V355" />
        <path d="M260 297V379Q260 403 236 403H128" />
      </g>
      <g strokeWidth="2" strokeLinecap="round" strokeDasharray="9 230" className="animate-transmit stroke-foreground opacity-60 motion-reduce:animate-none">
        <path d="M260 204V106Q260 82 284 82H390" />
        <path d="M86 114V219Q86 243 110 243H173" />
        <path d="M345 263H424Q448 263 448 287V355" />
        <path d="M128 403H236Q260 403 260 379V297" />
      </g>
      <g className="[&_circle]:fill-foreground [&_circle]:opacity-40 [&_rect]:fill-background [&_rect]:stroke-border [&_text]:fill-muted-foreground [&_text]:font-mono [&_text]:text-[10px] [&_text]:tracking-[.4px]">
        <rect x="27" y="44" width="118" height="72" rx="12" />
        <rect x="369" y="48" width="118" height="72" rx="12" />
        <rect x="389" y="355" width="118" height="72" rx="12" />
        <rect x="21" y="368" width="108" height="72" rx="12" />
        <g strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className="stroke-muted-foreground">
          <path d="M46 64h16m-16 8h25m-25 8h12" />
          <path d="m389 68 7 7-7 7m14 0h13" />
          <path d="m409 377 6-6 6 6-6 6-6-6Zm14 8 6-6 6 6-6 6-6-6Z" />
          <path d="M41 389h29m-29 7h18" />
        </g>
        <text x="46" y="100">GET /v1</text><circle cx="127" cy="62" r="3" />
        <text x="389" y="104">REST</text><circle cx="469" cy="66" r="3" />
        <text x="409" y="412">WSS</text><circle cx="489" cy="373" r="3" />
        <text x="41" y="424">POST /v1</text><circle cx="111" cy="386" r="3" />
      </g>
      <g strokeLinejoin="round" className="drop-shadow-[0_16px_16px_color-mix(in_srgb,var(--foreground)_8%,transparent)]">
        <path d="m115 273 145-77 145 77v28l-145 77-145-77Z" className="fill-surface-subtle stroke-border" />
        <path d="m115 273 145-77 145 77-145 77Z" className="fill-surface-card stroke-border" />
        <path d="m115 243 145-77 145 77v24l-145 77-145-77Z" className="fill-surface-subtle stroke-border" />
        <path d="m115 243 145-77 145 77-145 77Z" className="fill-surface-card stroke-border" />
        <path d="m115 206 145-77 145 77v26l-145 77-145-77Z" className="fill-surface-subtle stroke-border" />
        <path d="m115 206 145-77 145 77-145 77Z" strokeOpacity=".25" className="fill-background stroke-foreground" />
        <path d="m132 206 128-68 128 68-128 68Z" className="stroke-border" />
        <path d="M260 309v-26m0 61v-24m0 58v-28" className="stroke-border" />
        <g transform="translate(260 206) matrix(1 .53 -1 .53 0 0) translate(0 4)">
          <g transform="translate(-15 -9)">
            <path d="M6-27H12L0-7H-6Zm12 0h6L12-7H6Zm12 0h6L24-7h-6Z" className="fill-foreground" />
          </g>
          <text x="-50" y="28" textLength="100" lengthAdjust="spacingAndGlyphs" className="fill-foreground font-sans text-[37px] font-semibold tracking-[-1.5px]">PODS</text>
        </g>
        <path d="m141 251 22 12m-22 18 22 12m-22 18 22 12" strokeWidth="2" strokeLinecap="round" className="stroke-muted-foreground" />
        <circle cx="378" cy="249" r="2" className="fill-foreground" />
        <circle cx="370" cy="253" r="2" className="fill-foreground" />
        <circle cx="362" cy="257" r="2" className="fill-foreground" />
      </g>
      <g className="pointer-events-none stroke-muted-foreground opacity-[.18]">
        <circle cx="260" cy="230" r="199" strokeDasharray="2 9" />
      </g>
    </svg>
  </div>;
}
