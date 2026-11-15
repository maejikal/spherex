import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

function componentUrl(file, expose = '') {
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8') + expose, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const resolved = outputText.replace(/import ['"][^'"]+\.css['"];?/g, '')
    .replace(/from (['"])([^'"]+)\1/g, (_, quote, name) => {
      const url = name.startsWith('.') ? new URL(name, file) : null;
      return `from ${quote}${url ? name.endsWith('.tsx') ? componentUrl(url) : url.href : import.meta.resolve(name)}${quote}`;
    });
  return `data:text/javascript;base64,${Buffer.from(resolved).toString('base64')}`;
}
const file = new URL('../src/components/review/CommunityReview.tsx', import.meta.url);
const { ReviewResults, VoteForm, ReviewQueueEntry, ReviewBlinkPopup } = await import(componentUrl(file, '\nexport { ReviewResults, VoteForm, ReviewQueueEntry, ReviewBlinkPopup };'));
const item = { votes: [{ reviewerId: 'reviewer-1', decision: 'investigate', comment: 'Fixture comment' }] };

test('review summary stays visible; breakdown and reviewer comments use collapsed disclosure', () => {
  const markup = renderToStaticMarkup(createElement(ReviewResults, { item }));
  assert.match(markup, /1 review · 100% support/);
  assert.match(markup, /<details[^>]*><summary>Review breakdown and comments<\/summary>/);
  assert.doesNotMatch(markup, /<details[^>]*\bopen/);
  assert.match(markup, /Fixture comment/);
  assert.match(markup, /five distinct reviewers and 80% support/);
});

test('review decision and submit stay direct; optional comment uses collapsed disclosure', () => {
  const markup = renderToStaticMarkup(createElement(VoteForm, { item, identity: 'reviewer-2', saving: false, onSave: async () => {} }));
  assert.equal((markup.match(/type="radio"/g) ?? []).length, 3);
  assert.match(markup, /<details[^>]*><summary>Add a comment \(optional\)<\/summary>/);
  assert.match(markup, /Submit review/);
  assert.match(markup, /maxLength="3000"/);
  assert.doesNotMatch(markup, /<details[^>]*\bopen/);
});

test('no reviews does not imply a measured support percentage', () => {
  const markup = renderToStaticMarkup(createElement(ReviewResults, { item: { votes: [] } }));
  assert.match(markup, /No reviews yet/);
  assert.doesNotMatch(markup, /\b0% support/);
});

test('existing comment stays expanded when updating a review', () => {
  const markup = renderToStaticMarkup(createElement(VoteForm, { item, identity: 'reviewer-1', saving: false, onSave: async () => {} }));
  assert.match(markup, /<details[^>]*\bopen/);
  assert.match(markup, /Fixture comment/);
  assert.match(markup, /Update review/);
});


test('each queue entry has independent review and blink buttons; blink opens that exact case', () => {
  const saved = { id:'case-2', title:'Fixture observation', authorId:'author', status:'open', votes:[], analysis:{ra:42,dec:-8,mode:'local'} };
  let selected;
  const element = ReviewQueueEntry({item:saved,onOpenBlink:(entry)=>{selected=entry;}});
  const markup = renderToStaticMarkup(element);
  assert.equal((markup.match(/<button /g)??[]).length,2);
  assert.match(markup,/Open Fixture observation in blink viewer/);
  assert.match(markup,/Open in blink viewer/);
  assert.match(markup,/<\/button><button/);
  element.props.children[1].props.onClick();
  assert.equal(selected,saved);
});


test('review blink uses a dedicated modal for the exact case with local close behavior', () => {
  const saved={id:'popup-case',title:'Fixture object',analysis:{ra:42,dec:-7}};
  let closed=0;
  const popup=ReviewBlinkPopup({item:saved,onClose:()=>{closed++;}});
  assert.equal(popup.props.title,'Blink viewer');
  assert.equal(popup.props.className,'review-dialog--blink');
  assert.equal(popup.props.closeLabel,'Close blink viewer');
  assert.equal(popup.props.children[0].props.children,'Fixture object');
  const player=popup.props.children[2].props.children;
  assert.equal(player.props.item,saved);
  player.props.onReturn();
  assert.equal(closed,1);
  popup.props.onClose();
  assert.equal(closed,2);
});
