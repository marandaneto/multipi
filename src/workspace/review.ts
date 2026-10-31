import { createTwoFilesPatch } from "diff";
import { z } from "zod";

const file = z
  .object({
    path: z.string().min(1).max(1000),
    content: z.string().nullable(),
    mode: z.enum(["100644", "100755"]),
  })
  .strict();
export const reviewSchema = z
  .object({
    patch: z.string().max(4 * 1024 * 1024),
    files: z.array(file).max(100),
  })
  .strict();
export const captureSchema = z
  .object({
    files: z
      .array(
        file.extend({
          beforeContent: z.string().nullable(),
          beforeMode: z.enum(["100644", "100755"]).nullable(),
        }),
      )
      .max(100),
  })
  .strict();

export const captureScript = `
const fs=await import("node:fs/promises");
const {execFileSync}=await import("node:child_process");
const git=(...args)=>execFileSync("git",["--no-replace-objects",...args],{encoding:"utf8",maxBuffer:2*1024*1024});
const base=process.argv[1];
const tracked=git("diff","--no-ext-diff","--no-textconv","--no-renames","--name-only","-z",base,"--").split("\\0").filter(Boolean);
const untracked=git("ls-files","--others","--exclude-standard","-z").split("\\0").filter(Boolean);
const paths=[...new Set([...tracked,...untracked])].sort();
if(paths.length>100)throw Error("At most 100 changed files supported");
let bytes=0;
const files=[];
for(const path of paths){
 if(path.startsWith("/")||path.split("/").some(p=>!p||p===".."||p===".git")||/[\\\\\\x00-\\x1f]/.test(path))throw Error("Unsupported path");
 let beforeContent=null,beforeMode=null;
 const baseEntry=git("ls-tree",base,"--",path);
 if(baseEntry){
  const mode=baseEntry.split(" ")[0];
  if(!["100644","100755"].includes(mode))throw Error("Unsupported base file mode");
  beforeMode=mode;
  const raw=execFileSync("git",["--no-replace-objects","cat-file","blob",base+":"+path],{maxBuffer:256*1024});
  if(raw.includes(0))throw Error("Binary base file");
  beforeContent=new TextDecoder("utf-8",{fatal:true}).decode(raw);
 }
 let content=null,mode=beforeMode??"100644";
 try{
  const stat=await fs.lstat(path);
  if(!stat.isFile()||stat.size>256*1024)throw Error("Only UTF-8 regular files up to 256 KiB supported");
  const raw=await fs.readFile(path);bytes+=raw.length;
  if(bytes>1024*1024||raw.includes(0))throw Error("Binary or oversized review");
  content=new TextDecoder("utf-8",{fatal:true}).decode(raw);mode=(stat.mode&0o111)?"100755":"100644";
 }catch(error){if(error.code!=="ENOENT")throw error;}
 files.push({path,content,mode,beforeContent,beforeMode});
}
process.stdout.write(JSON.stringify({files}));
`;

export function buildReview(captured: z.infer<typeof captureSchema>) {
  const files = captured.files.map(({ path, content, mode }) => ({
    path,
    content,
    mode,
  }));
  const patch = captured.files
    .map((file) => {
      const oldPath =
        file.beforeContent === null ? "/dev/null" : `a/${file.path}`;
      const newPath = file.content === null ? "/dev/null" : `b/${file.path}`;
      const mode =
        file.beforeMode === null
          ? `new file mode ${file.mode}\n`
          : file.content === null
            ? `deleted file mode ${file.beforeMode}\n`
            : file.beforeMode !== file.mode
              ? `old mode ${file.beforeMode}\nnew mode ${file.mode}\n`
              : "";
      return (
        `diff --git a/${file.path} b/${file.path}\n${mode}` +
        createTwoFilesPatch(
          oldPath,
          newPath,
          file.beforeContent ?? "",
          file.content ?? "",
          "",
          "",
          { context: 3 },
        )
      );
    })
    .join("");
  return reviewSchema.parse({ files, patch });
}
