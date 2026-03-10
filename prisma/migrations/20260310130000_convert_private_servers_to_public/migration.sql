-- 下架私密服务器功能：将所有非公开服务器改为公开、开放加入
UPDATE "servers"
SET "visibility" = 'public',
    "join_mode" = 'open',
    "discoverable" = false
WHERE "visibility" != 'public';
