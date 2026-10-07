import type { SqlDriver } from '../storage/durable-sqlite';
import type { ShellResult } from './policy';
import { SANDBOX } from './policy';
export class SandboxJournal {
  constructor(private sql: SqlDriver) {
    sql.exec('CREATE TABLE IF NOT EXISTS sbx_jobs(id TEXT PRIMARY KEY,agent TEXT NOT NULL,hash TEXT NOT NULL,phase TEXT NOT NULL,lease TEXT,result TEXT)');
    sql.exec('CREATE TABLE IF NOT EXISTS sbx_checkpoints(agent TEXT NOT NULL,chunk INTEGER NOT NULL,content TEXT NOT NULL,PRIMARY KEY(agent,chunk))');
  }
  start(id: string, agent: string, hash: string): ShellResult | undefined {
    return this.sql.transaction(() => {
      const prior = this.sql.all<{agent:string;hash:string;result:string|null}>('SELECT * FROM sbx_jobs WHERE id=?',id)[0];
      if (prior) {
        if (prior.agent !== agent || prior.hash !== hash) throw new Error('Shell operation id reused with different input');
        if (!prior.result) throw new Error('Shell operation interrupted or still running; automatic replay denied');
        return JSON.parse(prior.result) as ShellResult;
      }
      if (this.sql.all<{n:number}>('SELECT COUNT(*) AS n FROM sbx_jobs')[0].n >= 500) throw new Error('Lifetime sandbox operation journal full; owner review required');
      this.sql.run("INSERT INTO sbx_jobs VALUES(?,?,?,'admitting',NULL,NULL)",id,agent,hash);
    });
  }
  lease(id:string,token:string) { this.sql.run("UPDATE sbx_jobs SET phase='running',lease=? WHERE id=?",token,id); }
  finish(id:string,result:ShellResult) { this.sql.run("UPDATE sbx_jobs SET phase='finished',result=? WHERE id=?",JSON.stringify(result),id); }
  incomplete() { return this.sql.all<{id:string;lease:string|null}>("SELECT id,lease FROM sbx_jobs WHERE phase!='finished'"); }
  checkpoint(agent:string) {
    return this.sql.all<{content:string}>('SELECT content FROM sbx_checkpoints WHERE agent=? ORDER BY chunk',agent).map(row=>row.content).join('') || '{"version":1,"files":[]}';
  }
  save(agent:string,content:string) {
    if (new TextEncoder().encode(content).length > SANDBOX.checkpointWireBytes) throw new Error('Checkpoint too large');
    // Chunked ASCII checkpoint avoids SQLite per-row/KV limits; one atomic replacement.
    const parsed = JSON.parse(content);
    if (parsed.version !== 1 || !Array.isArray(parsed.files)) throw new Error('Invalid checkpoint');
    this.sql.transaction(() => {
      this.sql.run('DELETE FROM sbx_checkpoints WHERE agent=?',agent);
      for (let start=0,chunk=0;start<content.length;start+=65536,chunk++) this.sql.run('INSERT INTO sbx_checkpoints VALUES(?,?,?)',agent,chunk,content.slice(start,start+65536));
    });
  }
  status() {
    return { checkpoints: this.sql.all('SELECT agent,SUM(length(content)) AS bytes,COUNT(*) AS chunks FROM sbx_checkpoints GROUP BY agent'), jobs: this.sql.all('SELECT id,agent,phase FROM sbx_jobs ORDER BY rowid DESC LIMIT 20') };
  }
}
