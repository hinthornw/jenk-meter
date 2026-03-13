# Jenk Meter

Linear-style developer performance toolbar for any web app. Chrome/Arc extension that overlays live metrics at the bottom of every page.

![screenshot](https://github.com/hinthornw/jenk-meter/raw/main/screenshot.png)

## Metrics

| Metric | What it measures |
|--------|-----------------|
| **FPS** | Frames per second (from `requestAnimationFrame` deltas) |
| **Mem** | JS heap usage (Chrome-only) |
| **Delay** | Event-loop lag — how long the main thread is blocked |
| **Jank** | % of frames that missed the 16.67ms budget |
| **Net** | In-flight `fetch` and `XMLHttpRequest` count |

Click **Jank** for a detailed breakdown: long tasks, layout shifts, frame histogram, and more.

## Install

### From source (Chrome / Arc / Brave / Edge)

1. Clone the repo:
   ```
   git clone https://github.com/hinthornw/jenk-meter.git
   ```
2. Open your browser's extension page:
   - Chrome: `chrome://extensions`
   - Arc: `arc://extensions`
   - Brave: `brave://extensions`
   - Edge: `edge://extensions`
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked**
5. Select the `jenk-meter` folder
6. Navigate to any page and refresh — the toolbar appears at the bottom

### Controls

- **↓** — Collapse the toolbar
- **—** — Hide the toolbar (refresh page to bring it back)

## In-app usage (without extension)

If you want to embed it directly in your app instead:

```ts
import { JankMeter } from "./src/jank-meter";

const jm = new JankMeter({ enabled: true });
jm.start();

// Optional: clean up
jm.stop();
```

## License

MIT
