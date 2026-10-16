/** Only structured, title-specific links on known publisher hosts are exposed.
 * No image requests, publisher scraping, URL slug guesses or embedded readers.
 */
export interface PublisherLink {
  providerId: string;
  url: string;
  label: string;
  language: string;
}

const hosts: Record<string, string> = {
  "www.viz.com": "VIZ",
  "viz.com": "VIZ",
  "mangaplus.shueisha.co.jp": "MANGA Plus",
  "www.webtoons.com": "WEBTOON",
  "tapas.io": "Tapas",
  "www.tappytoon.com": "Tappytoon",
  "page.kakao.com": "KakaoPage",
  "ebookjapan.yahoo.co.jp": "ebookjapan",
  "kmanga.kodansha.com": "K MANGA",
  "comic-walker.com": "ComicWalker",
  "shonenjumpplus.com": "Shonen Jump+",
  "tonarinoyj.jp": "Tonari no Young Jump",
};

export function publisherLink(url: unknown, language: unknown): PublisherLink | null {
  if (typeof url !== "string") return null;
  try {
    const value = new URL(url);
    const label = hosts[value.hostname];
    if (value.protocol !== "https:" || value.username || value.password || !label) return null;
    const names: Record<string, string> = {
      English: "en",
      Japanese: "ja",
      Korean: "ko",
      Spanish: "es",
      French: "fr",
      Portuguese: "pt",
      Chinese: "zh",
    };
    const lang =
      typeof language === "string"
        ? names[language] || (/^[a-z]{2}(?:-[a-z]{2})?$/.test(language) ? language : "und")
        : "und";
    return { providerId: value.hostname, url: value.href, label, language: lang };
  } catch {
    return null;
  }
}
