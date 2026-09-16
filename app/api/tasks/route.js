import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/authOptions";

export async function PATCH(request) {
  try {
    const session = await getServerSession(authOptions);

    if (!session || !session.accessToken) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }

    const { taskListId, taskId, title } = await request.json();

    const response = await fetch(
      `https://tasks.googleapis.com/tasks/v1/lists/${taskListId}/tasks/${taskId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title }),
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      return new Response(JSON.stringify(errorData), { status: response.status });
    }

    const data = await response.json();
    return new Response(JSON.stringify(data), { status: 200 });
  } catch (error) {
    console.error("Task update error:", error);
    return new Response(JSON.stringify({ error: "Internal Server Error" }), { status: 500 });
  }
}
