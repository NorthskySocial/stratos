---
name: Clubhouse
description: A lively community zine for private rooms on ATProto.
colors:
  ink: '#20301f'
  ink-soft: '#4a5a47'
  paper: '#f4ead1'
  paper-light: '#fffaf0'
  paper-tint: '#fdf4dd'
  leaf: '#128f4a'
  leaf-dark: '#0b6b38'
  marigold: '#ffb500'
  editorial-pink: '#f0328c'
  sky: '#2f93d6'
  cyan: '#0e9f94'
  tangerine: '#ff7526'
  destructive: '#d9374f'
  violet: '#7553b7'
typography:
  display:
    fontFamily: 'Trebuchet MS, Arial Rounded MT Bold, system-ui, sans-serif'
    fontSize: 'clamp(3.7rem, 7.5vw, 6rem)'
    fontWeight: 900
    lineHeight: 0.92
    letterSpacing: '-0.035em'
  headline:
    fontFamily: 'Trebuchet MS, Arial Rounded MT Bold, system-ui, sans-serif'
    fontSize: 'clamp(2.6rem, 6vw, 4.8rem)'
    fontWeight: 900
    lineHeight: 0.92
    letterSpacing: '-0.035em'
  title:
    fontFamily: 'Trebuchet MS, Arial Rounded MT Bold, system-ui, sans-serif'
    fontSize: 'clamp(1.6rem, 2.2vw, 2.35rem)'
    fontWeight: 900
    lineHeight: 0.98
    letterSpacing: '-0.025em'
  body:
    fontFamily: 'Trebuchet MS, Arial Rounded MT Bold, system-ui, sans-serif'
    fontSize: '1rem'
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: 'Trebuchet MS, Arial Rounded MT Bold, system-ui, sans-serif'
    fontSize: '0.75rem'
    fontWeight: 900
    lineHeight: 1
    letterSpacing: '0.045em'
rounded:
  field: '0.6rem'
  control: '0.65rem'
  card: '0.9rem'
  sticker: '0.55rem'
  pill: '999px'
spacing:
  control-x: '1rem'
  card: '1.35rem'
  grid: '1.7rem'
  section: '3.5rem'
components:
  button-primary:
    backgroundColor: '{colors.marigold}'
    textColor: '{colors.ink}'
    typography: '{typography.label}'
    rounded: '{rounded.control}'
    padding: '0.65rem 1rem'
    height: '2.75rem'
  button-secondary:
    backgroundColor: '{colors.paper-light}'
    textColor: '{colors.ink}'
    typography: '{typography.label}'
    rounded: '{rounded.control}'
    padding: '0.65rem 1rem'
    height: '2.75rem'
  field:
    backgroundColor: '{colors.paper-light}'
    textColor: '{colors.ink}'
    rounded: '{rounded.field}'
    padding: '0.58rem 0.75rem'
    height: '2.75rem'
  room-card:
    backgroundColor: '{colors.paper-light}'
    textColor: '{colors.ink}'
    rounded: '{rounded.card}'
    padding: '1.25rem 1.35rem 1.35rem'
  status-chip:
    backgroundColor: '{colors.paper-tint}'
    textColor: '{colors.ink}'
    typography: '{typography.label}'
    rounded: '{rounded.pill}'
    padding: '0.33rem 0.58rem'
---

# Design System: Clubhouse

## Overview

**Creative North Star: "The Living Room Zine"**

Clubhouse borrows its visual world from Martha's Bloom zine language: warm paper,
dense green-black ink, imperfect-looking stickers, and saturated print plates. It
should feel assembled by a community with opinions, not generated from a generic
software dashboard kit.

The system is expressive but operational. Strong hierarchy makes room state,
membership actions, authorship, and destructive actions immediately legible.
Color gives each room a distinct voice while shared borders, shadows, and type keep
the publication coherent.

**Key Characteristics:**

- Warm, lightly speckled paper rather than a clean digital canvas.
- Heavy editorial type with compact labels and plain, readable body copy.
- Thick green-black rules, hard offset print shadows, tape, stamps, and flat shapes.
- A distinct colorful IconaMoon pictogram for every room and every interface icon.
- Asymmetrical editorial grids on wide screens and an intentional single column on phones.

## Colors

The palette behaves like a small spot-color print run: paper and ink establish the
page, then saturated accents identify rooms and actions.

### Primary

- **Green-black Ink:** The universal text, outline, and structural-rule color.
- **Warm Newsprint:** The page field and the source of the zine's physical warmth.
- **Leaf Green:** Positive and community-oriented actions, links, and author identity.

### Secondary

- **Marigold Plate:** Primary buttons, the brand mark, and high-attention stickers.
- **Editorial Pink:** Links, active emphasis, tape, and playful editorial marks.
- **Sky Blue:** Keyboard focus and one of the principal room identities.

### Tertiary

- **Cyan, Tangerine, and Violet:** Additional room identities; never generic semantic status colors.
- **Destructive Red:** Reserved for deletion and error-adjacent destructive confirmation.

### Neutral

- **Clean Paper:** Cards, dialogs, and the clearest reading surfaces.
- **Tinted Paper:** Quiet status surfaces and secondary panels.
- **Soft Ink:** Descriptions and supporting metadata.

**The Paper-and-Ink Rule.** Every surface must still read clearly with only the
paper family and green-black ink; accent colors add identity, never basic legibility.

**The Spot-Color Rule.** Use flat saturated plates. Do not soften room identities
into pastel gradients or distribute every accent equally across a screen.

## Typography

**Display Font:** Trebuchet MS, with Arial Rounded MT Bold and system sans fallbacks

**Body Font:** Trebuchet MS, with the same fallbacks

**Label Font:** Trebuchet MS, with the same fallbacks

**Character:** A single dense sans family creates the blunt, friendly pressure of a
community flyer. Contrast comes from scale, weight, spacing, and case rather than a
decorative second face.

### Hierarchy

- **Display:** Extra-bold, tightly tracked, compact leading; reserved for the entrance invitation.
- **Headline:** Extra-bold room titles with balanced wrapping and a stricter phone scale.
- **Title:** Extra-bold card headings, kept short enough to act like editorial cover lines.
- **Body:** Comfortable reading rhythm with descriptions generally capped near 52–62 characters.
- **Label:** Small, extra-bold, often uppercase; used for state, identity, and control text.

**The One Loud Voice Rule.** Only the primary page or room title uses display scale.
Card titles are forceful, but never compete with the page's first reading stop.

## Layout

The main frame tops out at 1180px with generous paper around it. The room catalogue
uses a twelve-column editorial grid whose 7/5, 5/7, and 4/8 spans create a changing
rhythm instead of uniform product cards. Room interiors narrow to 900px for reading.

At 900px, cards settle into a two-column rhythm with selected full-width features.
At 680px, the catalogue becomes one column and complex rows stack. At 430px, the
header becomes a single-column sign-in block and room headings use a phone-specific
scale that keeps long names within their outlined container. Interactive targets are
at least 44px high.

**The Editorial Rhythm Rule.** Wide layouts must vary scale or span. Repeated equal
cards are not the Clubhouse composition.

## Elevation & Depth

Depth is structural, not ambient. Cards and controls use opaque green-black offset
shadows that resemble a slightly misregistered print layer. Primary panels use a
5px by 6px shadow; compact controls use a 3px by 3px shadow. Hovering a room shifts
the card against that printed shadow rather than adding blur.

**The Hard Shadow Rule.** Use hard offset shadows only with an outlined paper or
spot-color surface. Never substitute soft glassy elevation or blurred ambient glow.

## Shapes

Cards use sturdy 0.9rem corners and 3px outlines. Controls use tighter 0.6–0.65rem
corners and 2px outlines. Icon tiles use one noticeably clipped corner, while status
chips and avatars are circular or pill-shaped. Tape strips, rotated stamps, circles,
and tilted paper rectangles supply the zine's controlled irregularity.

## Components

### Buttons

- **Shape:** Compact outlined control with a sturdy corner and a 44px minimum height.
- **Primary:** Marigold plate, green-black ink, and a small hard shadow.
- **Secondary:** Clean paper with the same outline and a shallower hard shadow.
- **Hover / Focus:** Press the shadow inward on hover; use an unmistakable sky-blue focus outline.
- **Destructive:** Red plate with white text, shown only inside explicit delete confirmation.

### Chips

- **Style:** Small heavy label inside a 2px pill outline.
- **State:** Joined is acid green, pending is marigold, unavailable is muted paper.

### Cards / Containers

- **Corner Style:** Sturdy rounded rectangle with a 3px green-black outline.
- **Background:** Clean or tinted paper; colored room posters sit above the reading surface.
- **Shadow Strategy:** Hard offset print shadow only.
- **Internal Padding:** Approximately the card spacing token, adjusted only for density.

### Inputs / Fields

- **Style:** Paper field, 2px ink stroke, compact corners, and inset registration shadow for handles.
- **Focus:** Sky-blue 3px outline with a 4px offset.
- **Error / Disabled:** Preserve the outline; use muted saturation or a pink-tinted paper state.

### Navigation

The header is a compact masthead. Text links are editorial pink, heavy, underlined,
and offset from surrounding copy. The home mark and all navigation glyphs use local
IconaMoon artwork.

### Room Identity

Each room receives one stable icon and one stable color treatment. Room cards expand
that identity into a flat poster plate with outlined geometric print shapes. The same
icon tile returns in the room heading so the catalogue and conversation view feel like
the same issue of the publication.

### Loading State

Loading uses an IconaMoon tile with a small vertical nudge and rotation. It never uses
a circular spinner or swirly SVG.

## Do's and Don'ts

### Do:

- **Do** use local IconaMoon files for every interface icon, including loading and empty states.
- **Do** give every room a stable, distinct icon and color treatment.
- **Do** combine thick rules, flat print colors, and hard shadows as one coherent material system.
- **Do** keep access, error, empty, pending, and destructive states as carefully styled as the happy path.
- **Do** reduce motion when the visitor requests it.

### Don't:

- **Don't** fall back to soft SaaS cards, glass panels, ambient shadows, or a uniform dashboard grid.
- **Don't** use emoji, text glyphs, external icon families, or circular spinner artwork as icons.
- **Don't** use color alone to communicate room or post state.
- **Don't** let decorative tape, rotation, or print shapes obscure controls or reading order.
- **Don't** expose Stratos boundary identifiers as visible decoration or UI state.
