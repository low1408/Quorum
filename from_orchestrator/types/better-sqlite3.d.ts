declare module 'better-sqlite3' {
  type Statement = {
    run(...params: any[]): any;
    get(...params: any[]): any;
    all(...params: any[]): any[];
  };

  class Database {
    constructor(filename: string);
    pragma(source: string): any;
    prepare(source: string): Statement;
    transaction<T extends (...args: any[]) => any>(fn: T): T;
    close(): void;
  }

  export default Database;
}
