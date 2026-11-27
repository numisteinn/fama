fn main() {
    let code = arch_check::run_cli(std::env::args().collect());
    std::process::exit(code);
}
