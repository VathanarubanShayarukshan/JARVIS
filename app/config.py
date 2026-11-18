import os
from pathlib import Path

# httpx 0.28 crashes on IPv6 literals in NO_PROXY ("Invalid port: ':1]'").
for _var in ("NO_PROXY", "no_proxy"):
    _val = os.environ.get(_var)
    if _val:
        _clean = ",".join(e for e in _val.split(",") if "[" not in e and "::" not in e)
        if _clean != _val:
            os.environ[_var] = _clean

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "jarvis"
    port: int = 8000

    data_dir: Path = Path("data")
    workspace_dir: Path | None = None
    admin_token: str = ""

    default_model: str = ""

    open_access: bool = False

    max_tool_iterations: int = 0
    max_messages: int = 60

    provider_base_url: str = ""
    provider_api_key: str = ""
    provider_models: str = ""

    def prepared(self) -> "Settings":
        self.data_dir.mkdir(parents=True, exist_ok=True)
        if self.workspace_dir is None:
            self.workspace_dir = self.data_dir / "workspace"
        self.workspace_dir.mkdir(parents=True, exist_ok=True)
        return self.model_copy()

    @property
    def db_path(self) -> Path:
        return self.data_dir / "app.db"

    @property
    def workspace(self) -> Path:
        return (self.workspace_dir or (self.data_dir / "workspace")).resolve()


settings = Settings().prepared()