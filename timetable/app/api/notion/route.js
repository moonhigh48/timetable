import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/authOptions";

// --- 환경변수 ---
// NOTION_API_KEY: Notion Integration Secret (Internal Integration Token)
// NOTION_TIMETABLE_DATABASE_ID: 타임테이블을 저장할 Notion 데이터베이스 ID
// 두 값 모두 서버에서만 사용되며 클라이언트로 절대 노출되지 않습니다.

const NOTION_VERSION = "2022-06-28";
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const DATABASE_ID = process.env.NOTION_TIMETABLE_DATABASE_ID;

function notionHeaders() {
  return {
    Authorization: `Bearer ${NOTION_API_KEY}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

// Notion page(row) -> 위젯에서 쓰는 block 객체로 변환
function pageToBlock(page) {
  const props = page.properties;
  return {
    id: page.id,
    notionPageId: page.id,
    title: props?.Name?.title?.[0]?.plain_text ?? "",
    day: props?.Day?.number ?? 0,
    start: props?.Start?.number ?? 0,
    end: props?.End?.number ?? 0,
    color: props?.Color?.rich_text?.[0]?.plain_text ?? "#8b8b8b",
    source: "manual",
  };
}

// block 객체 -> Notion page properties
function blockToProperties(block) {
  return {
    Name: { title: [{ text: { content: block.title || "제목 없음" } }] },
    Day: { number: block.day },
    Start: { number: block.start },
    End: { number: block.end },
    Color: { rich_text: [{ text: { content: block.color || "#8b8b8b" } }] },
  };
}

async function queryAllPages() {
  let results = [];
  let cursor = undefined;
  do {
    const res = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
      method: "POST",
      headers: notionHeaders(),
      body: JSON.stringify(cursor ? { start_cursor: cursor } : {}),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.message || `Notion query failed (${res.status})`);
    }
    const data = await res.json();
    results = results.concat(data.results || []);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return results;
}

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }
    if (!NOTION_API_KEY || !DATABASE_ID) {
      return new Response(
        JSON.stringify({ error: "Notion 환경변수(NOTION_API_KEY / NOTION_TIMETABLE_DATABASE_ID)가 설정되지 않았습니다." }),
        { status: 500 }
      );
    }

    const pages = await queryAllPages();
    const blocks = pages.filter((p) => !p.archived).map(pageToBlock);
    return new Response(JSON.stringify({ blocks }), { status: 200 });
  } catch (error) {
    console.error("Notion GET error:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), { status: 500 });
  }
}

// 전체 교체 동기화: 기존 DB의 모든 row를 archive한 뒤, 현재 로컬 상태로 새로 생성합니다.
// (개인용 소규모 타임테이블 기준으로 단순함을 우선한 설계입니다.)
export async function POST(request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }
    if (!NOTION_API_KEY || !DATABASE_ID) {
      return new Response(
        JSON.stringify({ error: "Notion 환경변수(NOTION_API_KEY / NOTION_TIMETABLE_DATABASE_ID)가 설정되지 않았습니다." }),
        { status: 500 }
      );
    }

    const { blocks } = await request.json();
    if (!Array.isArray(blocks)) {
      return new Response(JSON.stringify({ error: "blocks 배열이 필요합니다." }), { status: 400 });
    }

    // 1) 기존 row 전체 삭제(archive)
    const existingPages = await queryAllPages();
    await Promise.all(
      existingPages.map((page) =>
        fetch(`https://api.notion.com/v1/pages/${page.id}`, {
          method: "PATCH",
          headers: notionHeaders(),
          body: JSON.stringify({ archived: true }),
        })
      )
    );

    // 2) 현재 블록들로 새로 생성
    const created = await Promise.all(
      blocks.map(async (block) => {
        const res = await fetch("https://api.notion.com/v1/pages", {
          method: "POST",
          headers: notionHeaders(),
          body: JSON.stringify({
            parent: { database_id: DATABASE_ID },
            properties: blockToProperties(block),
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err?.message || `Notion page 생성 실패 (${res.status})`);
        }
        const page = await res.json();
        return { ...block, id: page.id, notionPageId: page.id, source: "manual" };
      })
    );

    return new Response(JSON.stringify({ blocks: created }), { status: 200 });
  } catch (error) {
    console.error("Notion POST error:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), { status: 500 });
  }
}
