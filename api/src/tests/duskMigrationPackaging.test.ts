import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync,readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('every canonical migration is explicitly admitted to the daemon Docker context',()=>{
  const root=resolve(__dirname,'../../..');
  const manifest=readFileSync(resolve(root,'database/dusk-migrations.txt'),'utf8').split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&!line.startsWith('#'));
  const ignored=readFileSync(resolve(root,'.dockerignore'),'utf8').split(/\r?\n/).map(line=>line.trim());
  for(const name of manifest){
    assert(existsSync(resolve(root,'database/migrations',name)),`Missing canonical migration: ${name}`);
    assert(ignored.includes(`!database/migrations/${name}`),`Docker context omits canonical migration: ${name}`);
  }
});
