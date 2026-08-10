#!/usr/bin/env node

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const issueRoot = path.join(root, 'uifn/.conduct/issues/SFO-45');
const visualRoot = path.join(issueRoot, 'visual');
const publicCss = readFileSync(path.join(root, 'uifn/components/styles.css'), 'utf8');
const frameworks = {
  react: process.env.UIFN_REACT_CATALOG_URL ?? 'http://127.0.0.1:6111',
  svelte: process.env.UIFN_SVELTE_CATALOG_URL ?? 'http://127.0.0.1:6112',
  solid: process.env.UIFN_SOLID_CATALOG_URL ?? 'http://127.0.0.1:6114',
};
const themes = ['light', 'dark'];
const pilots = ['button', 'field', 'input', 'checkbox', 'switch', 'select', 'combobox', 'dialog', 'menu', 'tabs', 'card', 'table'];
const styleProperties = [
  'position', 'backgroundColor', 'color',
  'borderTopColor', 'borderTopStyle', 'borderTopWidth', 'borderRadius', 'boxShadow',
  'fontFamily', 'fontSize', 'fontWeight', 'lineHeight',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'gap', 'maxWidth', 'opacity', 'visibility', 'overflow',
  'textDecorationLine', 'whiteSpace',
];

rmSync(visualRoot, { recursive: true, force: true });
mkdirSync(visualRoot, { recursive: true });

function stable(value) {
  return JSON.stringify(value);
}

function xml(value) {
  return String(value).replace(/[<>&'"]/g, (character) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  })[character]);
}

async function makeTile(buffer, label, dark) {
  const resized = await sharp(buffer)
    .resize({ width: 660, height: 610, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
  const metadata = await sharp(resized).metadata();
  const background = dark ? '#111827' : '#f7f8fb';
  const foreground = dark ? '#f9fafb' : '#111827';
  const labelSvg = Buffer.from(
    `<svg width="680" height="40" xmlns="http://www.w3.org/2000/svg"><rect width="680" height="40" fill="${background}"/><text x="12" y="26" font-family="ui-sans-serif,system-ui" font-size="16" font-weight="700" fill="${foreground}">${xml(label)}</text></svg>`,
  );
  return sharp({ create: { width: 680, height: 660, channels: 4, background } })
    .composite([
      { input: labelSvg, left: 0, top: 0 },
      { input: resized, left: Math.floor((680 - (metadata.width ?? 660)) / 2), top: 42 },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function makeSheet(tiles, output) {
  const rows = Math.ceil(tiles.length / 2);
  await sharp({ create: { width: 1360, height: rows * 660, channels: 4, background: '#0b1020' } })
    .composite(tiles.map((input, index) => ({
      input,
      left: (index % 2) * 680,
      top: Math.floor(index / 2) * 660,
    })))
    .png({ compressionLevel: 9 })
    .toFile(output);
}

async function collectCatalog(page, pilot) {
  return page.locator('section.fixture-card').evaluateAll((sections, input) => {
    const recordStyle = (element) => {
      const style = getComputedStyle(element);
      return Object.fromEntries(input.styleProperties.map((property) => [property, style[property]]));
    };
    return sections.map((section, fixtureIndex) => {
      const rootSelector = `[data-uifn-component="${input.pilot}"][data-uifn-part="root"]`;
      const componentRoot = section.querySelector(rootSelector);
      if (!componentRoot) return { fixtureIndex, missing: true };
      const parts = [componentRoot, ...componentRoot.querySelectorAll(`[data-uifn-component="${input.pilot}"][data-uifn-part]:not([data-uifn-part="root"])`)];
      return {
        fixtureIndex,
        label: section.querySelector('.eyebrow')?.textContent?.trim() ?? `fixture-${fixtureIndex + 1}`,
        html: componentRoot.outerHTML,
        metrics: {
          height: getComputedStyle(componentRoot).height,
          minHeight: getComputedStyle(componentRoot).minHeight,
        },
        recipe: {
          variant: componentRoot.getAttribute('data-uifn-variant'),
          size: componentRoot.getAttribute('data-uifn-size'),
          density: componentRoot.getAttribute('data-uifn-density'),
          unstyled: componentRoot.getAttribute('data-uifn-unstyled'),
        },
        parts: parts.map((part) => ({
          part: part.getAttribute('data-uifn-part'),
          tag: part.tagName.toLowerCase(),
          style: recordStyle(part),
        })),
      };
    });
  }, { pilot, styleProperties });
}

async function collectBlank(blankPage, fixtures, themeStyle, theme, pilot) {
  await blankPage.setContent(`<style>${publicCss}</style><main id="blank-consumer"></main>`);
  await blankPage.locator('#blank-consumer').evaluate((main, input) => {
    main.setAttribute('data-uifn-theme', input.theme);
    main.setAttribute('style', input.themeStyle);
    main.innerHTML = input.fixtures.map((fixture, index) => `<section data-fixture-index="${index}">${fixture.html ?? ''}</section>`).join('');
  }, { fixtures, themeStyle, theme });
  return blankPage.locator('[data-fixture-index]').evaluateAll((sections, input) => {
    const recordStyle = (element) => {
      const style = getComputedStyle(element);
      return Object.fromEntries(input.styleProperties.map((property) => [property, style[property]]));
    };
    return sections.map((section, fixtureIndex) => {
      const componentRoot = section.querySelector(`[data-uifn-component="${input.pilot}"][data-uifn-part="root"]`);
      if (!componentRoot) return { fixtureIndex, missing: true };
      const parts = [componentRoot, ...componentRoot.querySelectorAll(`[data-uifn-component="${input.pilot}"][data-uifn-part]:not([data-uifn-part="root"])`)];
      return {
        fixtureIndex,
        recipe: {
          variant: componentRoot.getAttribute('data-uifn-variant'),
          size: componentRoot.getAttribute('data-uifn-size'),
          density: componentRoot.getAttribute('data-uifn-density'),
          unstyled: componentRoot.getAttribute('data-uifn-unstyled'),
        },
        parts: parts.map((part) => ({
          part: part.getAttribute('data-uifn-part'),
          tag: part.tagName.toLowerCase(),
          style: recordStyle(part),
        })),
      };
    });
  }, { pilot, styleProperties });
}

const browser = await chromium.launch({ headless: true });
const results = [];
const artifacts = [];
const failures = [];
try {
  for (const [framework, baseUrl] of Object.entries(frameworks)) {
    for (const theme of themes) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', colorScheme: theme });
      const blankPage = await browser.newPage({ viewport: { width: 1200, height: 900 }, reducedMotion: 'reduce', colorScheme: theme });
      const tiles = [];
      for (const pilot of pilots) {
        const url = `${baseUrl}/components/${pilot}/states?theme=${theme}`;
        const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
        const rootSelector = `[data-uifn-component="${pilot}"][data-uifn-part="root"]`;
        await page.locator(rootSelector).first().waitFor({ state: 'attached', timeout: 15_000 });
        const themeStyle = await page.locator('.workbench-shell').getAttribute('style') ?? '';
        const catalog = await collectCatalog(page, pilot);
        const blank = await collectBlank(blankPage, catalog, themeStyle, theme, pilot);
        const parityFailures = [];
        for (let index = 0; index < catalog.length; index += 1) {
          const catalogComparable = { recipe: catalog[index]?.recipe, parts: catalog[index]?.parts };
          const blankComparable = { recipe: blank[index]?.recipe, parts: blank[index]?.parts };
          if (stable(catalogComparable) !== stable(blankComparable)) {
            parityFailures.push({ fixtureIndex: index, label: catalog[index]?.label, catalog: catalogComparable, blank: blankComparable });
          }
        }
        if (!response?.ok() || catalog.some((fixture) => fixture.missing) || parityFailures.length) {
          failures.push({ framework, theme, pilot, status: response?.status(), parityFailures });
        }
        const screenshot = await page.locator('.fixture-grid').first().screenshot({ animations: 'disabled' });
        tiles.push(await makeTile(screenshot, `${pilot} · states`, theme === 'dark'));
        results.push({
          framework,
          theme,
          pilot,
          fixtureCount: catalog.length,
          rootCount: catalog.filter((fixture) => !fixture.missing).length,
          catalogBlankParity: parityFailures.length === 0,
          recipes: catalog.map((fixture) => ({ label: fixture.label, recipe: fixture.recipe, partCount: fixture.parts?.length ?? 0 })),
          visuals: catalog.map((fixture) => ({
            label: fixture.label,
            metrics: fixture.metrics,
            root: fixture.parts?.[0]?.style,
          })),
        });
      }
      for (let group = 0; group < 2; group += 1) {
        const filename = `${framework}-${theme}-pilots-${group + 1}.png`;
        const relative = `visual/${filename}`;
        await makeSheet(tiles.slice(group * 6, group * 6 + 6), path.join(issueRoot, relative));
        artifacts.push({ framework, theme, pilots: pilots.slice(group * 6, group * 6 + 6), path: `uifn/.conduct/issues/SFO-45/${relative}` });
      }
      await page.close();
      await blankPage.close();
    }
  }
} finally {
  await browser.close();
}

for (const theme of themes) {
  for (const pilot of pilots) {
    const profiles = Object.fromEntries(Object.keys(frameworks).map((framework) => {
      const result = results.find((entry) => entry.framework === framework && entry.theme === theme && entry.pilot === pilot);
      return [framework, result ? { fixtureCount: result.fixtureCount, recipes: result.recipes } : null];
    }));
    if (new Set(Object.values(profiles).map(stable)).size !== 1) failures.push({ theme, pilot, code: 'cross-framework-recipe-mismatch', profiles });
  }
}

for (const result of results.filter((entry) => entry.pilot === 'button')) {
  const visuals = new Map(result.visuals.map((visual) => [visual.label, visual]));
  const sizeContract = {
    sm: visuals.get('size-sm')?.metrics?.minHeight,
    md: visuals.get('default')?.metrics?.minHeight,
    lg: visuals.get('size-lg')?.metrics?.minHeight,
  };
  const variantSignatures = ['variant-primary', 'variant-secondary', 'variant-outline', 'variant-ghost', 'variant-danger']
    .map((label) => visuals.get(label)?.root)
    .map((style) => stable({ background: style?.backgroundColor, color: style?.color, border: style?.borderTopColor }));
  if (stable(sizeContract) !== stable({ sm: '32px', md: '40px', lg: '48px' })) {
    failures.push({ framework: result.framework, theme: result.theme, pilot: 'button', code: 'button-size-contract-mismatch', sizeContract });
  }
  if (new Set(variantSignatures).size !== variantSignatures.length) {
    failures.push({ framework: result.framework, theme: result.theme, pilot: 'button', code: 'button-variant-visual-collision', variantSignatures });
  }
}

const report = {
  schemaVersion: 1,
  issue: 'SFO-45',
  generatedAt: new Date().toISOString(),
  status: failures.length ? 'failed' : 'passed',
  browsers: ['chromium'],
  requiredFrameworks: Object.keys(frameworks),
  requiredThemes: themes,
  requiredPilots: pilots,
  catalogBlankParity: failures.every((failure) => !(failure.parityFailures?.length)),
  crossFrameworkRecipeParity: failures.every((failure) => failure.code !== 'cross-framework-recipe-mismatch'),
  artifacts,
  results,
  failures,
};
writeFileSync(path.join(issueRoot, 'BROWSER_REVIEW.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ok: failures.length === 0, command: 'capture:uifn-styled-pilots', resultCount: results.length, artifacts, failures }, null, 2));
process.exit(failures.length ? 1 : 0);
