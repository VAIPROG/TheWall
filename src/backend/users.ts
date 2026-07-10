import { BackendClient } from "./client";
import { BackendUser } from "./types";

export interface ProfileUpdate {
  bio?: string;
  socialLinks?: Record<string, string>;
  displayName?: string;
}

export function buildUsersApi(client: BackendClient) {
  const path = (ref: string) => `/users/${encodeURIComponent(ref)}`;

  return {
    me: () => client.get<BackendUser>("/users/me"),

    get: (ref: string) => client.get<BackendUser>(path(ref)),

    updateMe: (body: ProfileUpdate) => client.patch("/users/me", body),

    // Avatar + self-delete still use the V1 root endpoints. V3's avatar upload
    // is multipart/form-data (POST /api/v3/users/me/avatar) and there is no V3
    // self-delete route yet, so these resolve against the API root.
    // TODO(phase3): switch setAvatar to the V3 multipart upload.
    avatar: () => client.getRoot<string>("/me/avatar"),

    setAvatar: (image: string) => client.putRoot("/me/avatar", { image }),

    deleteMe: (reason?: string) =>
      client.postRoot("/me/delete", { confirm: true, reason }),
  };
}
