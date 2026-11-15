export function readReviewRoute(search: string): string | null {
  return new URLSearchParams(search).get('review') || null;
}
export function reviewSearch(search: string, id: string | null): string {
  const params = new URLSearchParams(search);
  if (id) params.set('review', id);
  else params.delete('review');
  const value = params.toString();
  return value ? `?${value}` : '';
}
export function navigateReview(id: string | null) {
  const search = reviewSearch(window.location.search, id);
  if (search === window.location.search) return;
  window.history.pushState(null, '', `${window.location.pathname}${search}${window.location.hash}`);
  window.dispatchEvent(new Event('reviewnavigate'));
}
