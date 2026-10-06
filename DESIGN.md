# Patchwork design

## Scene

A developer reviews a long agent-written change in a dim home office beside their terminal. A charcoal default reduces glare; a pure white theme serves bright daytime work. Both keep change signs and line numbers readable.

## Layout

46px activity rail, 272px resizable file explorer, flexible code workspace, compact toolbars and a 26px status bar. Optional right review panel. Sidebar collapses at narrow widths. Command palette and settings use native dialogs with focus management.

## Color

Restrained strategy. Neutral charcoal surfaces, honey-gold accent anchored at OKLCH hue 91, green additions, rose deletions and cyan syntax. Accent is reserved for selection, primary actions and active state. Four themes: Graphite, Midnight, Light and Terminal.

## Typography

System sans for compact controls. Local system monospace for code: Cascadia Code, SFMono-Regular, Consolas. 12–14px interface and configurable 11–18px code. No external font requests.

## Interaction

Keyboard-first, 160ms state transitions, persistent preferences, horizontal scrolling or wrapping, split/unified diff, full-file context, review progress. Change markers include symbols so color is never the only signal.
