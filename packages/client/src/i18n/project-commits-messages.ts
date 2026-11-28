/**
 * The commit list on a project's board cards (docs/project-commits.md), one
 * entry per locale. projects-messages.ts adds these under `projects.commits`.
 */
const en = {
  count: '{n} commit | {n} commits',
  all: 'Show all {n}',
  fewer: 'Show fewer',
  thinking: 'Thinking up a short summary…',
  noSummary: 'No summary: {error}',
  error: 'No commits: {error}',
}

type Messages = typeof en

export const projectCommitsMessages: Record<string, Messages> = {
  en,
  zh: { count: '{n} 个提交', all: '显示全部 {n} 个', fewer: '收起', thinking: '正在生成简短摘要…', noSummary: '没有摘要：{error}', error: '没有提交：{error}' },
  'zh-TW': { count: '{n} 個提交', all: '顯示全部 {n} 個', fewer: '收合', thinking: '正在產生簡短摘要…', noSummary: '沒有摘要：{error}', error: '沒有提交：{error}' },
  ja: { count: '{n} 件のコミット', all: 'すべて表示 ({n})', fewer: '折りたたむ', thinking: '短い要約を作成中…', noSummary: '要約なし: {error}', error: 'コミットなし: {error}' },
  ko: { count: '커밋 {n}개', all: '모두 보기 ({n})', fewer: '접기', thinking: '짧은 요약을 만드는 중…', noSummary: '요약 없음: {error}', error: '커밋 없음: {error}' },
  de: { count: '{n} Commit | {n} Commits', all: 'Alle {n} zeigen', fewer: 'Weniger zeigen', thinking: 'Kurze Zusammenfassung entsteht…', noSummary: 'Keine Zusammenfassung: {error}', error: 'Keine Commits: {error}' },
  es: { count: '{n} commit | {n} commits', all: 'Ver los {n}', fewer: 'Ver menos', thinking: 'Preparando un resumen corto…', noSummary: 'Sin resumen: {error}', error: 'Sin commits: {error}' },
  fr: { count: '{n} commit | {n} commits', all: 'Voir les {n}', fewer: 'Voir moins', thinking: 'Résumé court en préparation…', noSummary: 'Pas de résumé : {error}', error: 'Pas de commits : {error}' },
  pt: { count: '{n} commit | {n} commits', all: 'Ver todos os {n}', fewer: 'Ver menos', thinking: 'Preparando um resumo curto…', noSummary: 'Sem resumo: {error}', error: 'Sem commits: {error}' },
  ru: { count: '{n} коммит | {n} коммита', all: 'Показать все {n}', fewer: 'Свернуть', thinking: 'Готовлю краткое описание…', noSummary: 'Нет описания: {error}', error: 'Нет коммитов: {error}' },
  tr: { count: '{n} commit', all: '{n} commit’in hepsini göster', fewer: 'Daha az göster', thinking: 'Kısa özet hazırlanıyor…', noSummary: 'Özet yok: {error}', error: 'Commit yok: {error}' },
  ar: { count: '{n} إيداع', all: 'عرض الكل ({n})', fewer: 'عرض أقل', thinking: 'جارٍ إعداد ملخص قصير…', noSummary: 'لا ملخص: {error}', error: 'لا إيداعات: {error}' },
}
