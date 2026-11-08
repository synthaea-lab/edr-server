import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { authenticateAgent } from "@/lib/agent-auth";
import { DecoyLimitError, DecoyRegistration, registerDecoyTokens } from "@/lib/decoy";

/**
 * An agent registers the SHA-256 of the decoy credentials it planted (issue #81). Same
 * authentication as the other agent ingest routes: nginx proxy secret and mTLS. The agent
 * sends hashes only, so this route cannot leak a usable token.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await authenticateAgent(req);
    if ("response" in auth) return auth.response;
    const { agent } = auth;

    const body = DecoyRegistration.parse(await req.json());
    const result = await registerDecoyTokens(prisma, agent, body.tokens);

    await prisma.agent.update({ where: { id: agent.id }, data: { lastSeen: new Date() } });
    return NextResponse.json({ status: "accepted", ...result });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid payload", details: error.errors },
        { status: 400 }
      );
    }
    if (error instanceof DecoyLimitError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Decoy registration error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
