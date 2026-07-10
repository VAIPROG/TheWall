import { BackendClient } from "./client";

export interface ClanCreateRequest {
  name: string;
  tag?: string;
  description?: string;
}

export interface ClanJoinRequest {
  clanId: string;
  message?: string;
}

export function buildClansApi(client: BackendClient) {
  const path = (id: string) => `/clans/${encodeURIComponent(id)}`;

  return {
    list: () => client.get("/clans"),

    get: (id: string) => client.get(path(id)),

    create: (body: ClanCreateRequest) => client.post("/clans", body),

    join: (body: ClanJoinRequest) =>
      client.post(`${path(body.clanId)}/join`, { message: body.message }),

    leave: (id: string) => client.post(`${path(id)}/leave`),

    members: (id: string) => client.get(`${path(id)}/members`),

    templates: (id: string) => client.get(`${path(id)}/templates`),
  };
}
