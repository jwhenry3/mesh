/**
 * Types for the vendored MiniWidget — the JS file is intentionally plain,
 * un-typed "third-party" code; this declaration is what a consumer would
 * write (or the vendor would ship) for TS consumers.
 */
export declare const MiniWidget: {
  mount(root: unknown): unknown;
  unmount(): void;
  setLabel(text: string): void;
  readonly el: unknown;
  readonly pings: number;
};
