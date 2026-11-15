import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_ACCOUNTS, accountName, readDemoAccount, saveDemoAccount } from '../src/review/accounts.ts';
import { createReview, vote, advance } from '../src/review/model.ts';

const analysis = { imageSize:256, frames:[{id:'a'},{id:'b'}] };
const draft = {title:'Fixture observation',description:'Test only',marks:{a:{x:12,y:10},b:null}};

test('six demo accounts retain legacy identities and selection survives reload', () => {
  assert.equal(DEMO_ACCOUNTS.length,6);
  assert.equal(DEMO_ACCOUNTS[0].id,'author');
  const values = new Map();
  const storage = {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
  assert.equal(readDemoAccount(storage),'author');
  assert.equal(saveDemoAccount('reviewer-3',storage),true);
  assert.equal(readDemoAccount(storage),'reviewer-3');
  assert.equal(saveDemoAccount('invalid',storage),false);
  assert.equal(readDemoAccount({getItem:()=> 'unknown'}),'author');
  assert.match(accountName('reviewer-3'),/Demo/);
  assert.equal(accountName('unknown'),'Unknown demo account');
});
test('blocked browser storage falls back safely and reports selection cannot persist', () => {
  const blocked = {getItem:()=>{throw new Error('blocked');},setItem:()=>{throw new Error('blocked');}};
  assert.equal(readDemoAccount(blocked),'author');
  assert.equal(saveDemoAccount('reviewer-1',blocked),false);
});
test('any selected demo account can author; ownership and self-review follow case not fixed role', () => {
  for (const account of DEMO_ACCOUNTS) {
    let item = createReview(analysis,draft,'case','now',account.id);
    assert.equal(item.authorId,account.id);
    assert.throws(()=>vote(item,account.id,'investigate','','now'));
    const peers = DEMO_ACCOUNTS.filter(peer=>peer.id!==account.id);
    for (const peer of peers) item = vote(item,peer.id,'investigate','','now');
    assert.equal(item.votes.length,5);
    assert.throws(()=>advance(item,peers[0].id,'peer-approved','now'));
    assert.equal(advance(item,account.id,'peer-approved','now').status,'peer-approved');
  }
  assert.throws(()=>createReview(analysis,draft,'case','now','invalid'));
  assert.equal(createReview(analysis,draft,'case','now').authorId,'author');
});
