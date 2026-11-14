# Industry colour palette

*A free tool by [Federico Calicchia](https://calicchia.design/en), freelance web designer. No sign-up.*

> Tell it what your business is and, if you have one, upload your logo. The tool looks for photos of your industry, extracts their dominant colours and shows them on a website, a post and a business card, with the contrast already checked.

## What it does

1. **Industry.** Pick one of the ready-made industries or type your business. The ready-made industries have photos chosen and analysed in advance; for other businesses the search runs on the spot on Unsplash, translated into English.
2. **Photos and logo.** Each photo is reduced to its three dominant colours. If you upload a logo on a solid background, its background is removed: its colours (up to three) join the palette and stay fixed. You can add up to three of your own photos, which count double.
3. **Palette.** The five most representative colours, with no duplicates. Lock some and regenerate the rest, or choose which one to use as the primary.
4. **Style.** Four ready-made styles (Soft, Clean, Editorial, Technical), each with its own shapes, shadows and open-source fonts. The tool suggests one based on the industry and the colours.
5. **Preview and touchpoints.** The palette applied to a sample homepage, an Instagram post, a business card and a sign, with deuteranopia, protanopia, tritanopia and greyscale simulation (Machado et al., 2009 model).
6. **Contrast.** Every pair used for text is measured against the WCAG 2.2 criteria (4.5:1 for normal text, 3:1 for graphics). If a contrast falls short, the tool adjusts the lightness and keeps the hue.
7. **Export.** CSS variables, a Tailwind v4 theme, JSON tokens in DTCG format or the codes to paste into Canva. The palette can be shared with a link.

## Method

- 6 photos per industry, reduced to 64 × 48 thumbnails.
- 3 dominant colours per photo, with k-means in the OKLab colour space (perceptually uniform).
- Perceptual duplicates merged below ΔE 0.05; the 5 most representative and distinct colours remain.
- Background, text and neutrals derived for legibility; primary and accent taken from the extracted colours.

## Privacy

- The logo and photos you upload stay in your browser: they are never sent to a server.
- The shared link only holds the colours, the style and, for ready-made industries, the industry name. Never the search text.
- Unsplash photos are loaded straight from Unsplash's servers (hotlinking), as their guidelines require: your browser shares its IP address with Unsplash. Each photo carries the photographer's credit.

## Useful links

- Tool: <https://calicchia.design/en/risorse/palette-di-settore>
- Got a project? <https://calicchia.design/en/contact>
