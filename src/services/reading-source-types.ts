/** Shared chapter metadata; providers own transport and edition verification. */
export interface SourceChapter {
  id: string;
  number: string;
  title: string;
  language: string;
  groupNames: string[];
  url: string;
  volume?: string;
  externalUrl?: string;
  readable?: boolean;
  publishedAt?: string;
}
