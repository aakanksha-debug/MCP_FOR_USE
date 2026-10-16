import type { PageData } from "@/core/extract";
import type { Finding } from "@/core/types";
import { isOkHtml, keywordCoverage, loadTarget } from "./shared";
import { emptyOutput, type AuditModule } from "./types";

export interface AeoInput {
  url: string;
  /** Questions customers actually ask, from the user or Search Console. */
  questions?: string[];
}

export interface QuestionCoverage {
  question: string;
  covered: boolean;
  matchedHeading?: string;
  coverage: number;
}

/** A question counts as covered when a heading or the body text contains most of its keywords. */
export function questionCoverage(page: PageData, question: string): QuestionCoverage {
  let best: { heading: string; score: number } | undefined;
  for (const heading of page.headings) {
    const score = keywordCoverage(question, heading.text);
    if (!best || score > best.score) best = { heading: heading.text, score };
  }
  if (best && best.score >= 0.6) return { question, covered: true, matchedHeading: best.heading, coverage: best.score };
  const bodyScore = keywordCoverage(question, page.text);
  return { question, covered: bodyScore >= 0.75, coverage: bodyScore };
}

export function aeoFindings(page: PageData, questions: string[] = []): { findings: Finding[]; coverage: QuestionCoverage[] } {
  const findings: Finding[] = [];
  const add = (code: string, detail?: string, evidence?: Record<string, unknown>) =>
    findings.push({ code, url: page.url, ...(detail ? { detail } : {}), ...(evidence ? { evidence } : {}) });

  const answered = page.questions.filter((q) => q.answerWords >= 5);
  if (page.questions.length === 0 && page.wordCount > 150) add("aeo.questions.none");

  const indirect = page.questions.filter((q) => q.firstAnswerWords === 0 || q.firstAnswerWords > 90);
  if (page.questions.length >= 2 && indirect.length / page.questions.length >= 0.4) {
    add("aeo.answers.not_direct", `${indirect.length} of ${page.questions.length} questions lack a short direct answer`, {
      examples: indirect.slice(0, 5).map((q) => ({ question: q.question, firstAnswerWords: q.firstAnswerWords })),
    });
  }

  const coverage = questions.map((question) => questionCoverage(page, question));
  const uncovered = coverage.filter((item) => !item.covered);
  if (uncovered.length) {
    add("aeo.questions.uncovered", `${uncovered.length} of ${questions.length} questions not answered`, {
      questions: uncovered.map((item) => item.question),
    });
  }

  if (answered.length >= 2 && !page.schemaTypes.includes("FAQPage")) {
    add("aeo.faq_schema.missing", `${answered.length} visible question/answer pairs`);
  }
  if (page.wordCount > 600 && page.listCount + page.tableCount === 0) add("aeo.structure.no_lists", `${page.wordCount} words without lists or tables`);

  const long = page.paragraphs.filter((paragraph) => paragraph.split(/\s+/).length > 120);
  const average = page.paragraphs.length
    ? page.paragraphs.reduce((sum, paragraph) => sum + paragraph.split(/\s+/).length, 0) / page.paragraphs.length
    : 0;
  if (page.paragraphs.length >= 3 && (average > 90 || long.length / page.paragraphs.length > 0.3)) {
    add("aeo.paragraphs.long", `Average paragraph is ${Math.round(average)} words; ${long.length} exceed 120 words`);
  }
  return { findings, coverage };
}

export const aeoAudit: AuditModule<AeoInput> = {
  id: "aeo",
  name: "AEO Check",
  async run(ctx, input) {
    const output = emptyOutput();
    const { page } = await loadTarget(ctx, input.url);
    if (!isOkHtml(page)) {
      output.notes.push(`The page returned HTTP ${page.status}, so its content could not be checked.`);
      return output;
    }
    const questions = (input.questions ?? []).map((q) => q.trim()).filter(Boolean).slice(0, 25);
    const { findings, coverage } = aeoFindings(page, questions);
    output.findings.push(...findings);

    const direct = page.questions.filter((q) => q.firstAnswerWords > 0 && q.firstAnswerWords <= 90);
    if (page.questions.length) output.passed.push(`${page.questions.length} question-style headings found`);
    if (direct.length) output.passed.push(`${direct.length} questions are followed by a concise answer`);
    if (page.schemaTypes.includes("FAQPage")) output.passed.push("FAQPage structured data is present");
    if (coverage.length && coverage.every((item) => item.covered)) output.passed.push("All provided customer questions are answered");

    output.facts = {
      questionsOnPage: page.questions.slice(0, 15).map((q) => ({ question: q.question, firstAnswerWords: q.firstAnswerWords })),
      coverage,
      wordCount: page.wordCount,
      lists: page.listCount,
      tables: page.tableCount,
    };
    if (!questions.length) {
      output.askUser.push(
        "What 3-6 questions do customers ask most before buying? (Or connect Google Search Console so question searches can be pulled automatically.)",
      );
    }
    output.notes.push("Question coverage uses keyword matching, so review borderline matches manually.");
    return output;
  },
};
