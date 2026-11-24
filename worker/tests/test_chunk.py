from fama_worker.chunk import segments
from fama_worker.normalize import normalize


def same(text: str) -> str:
    return text


def icelandic(text: str) -> str:
    return normalize(text, "is")


def english(text: str) -> str:
    return normalize(text, "en")


def test_one_segment_for_each_sentence_and_none_crosses_a_paragraph():
    text = "One two three. Four five six. Seven eight.\n\nNew paragraph here."
    found = segments(text, 100, same, min_chars=0)
    assert [s.text for s in found] == ["One two three.", "Four five six.", "Seven eight.", "New paragraph here."]
    assert [s.ends_paragraph for s in found] == [False, False, True, True]


def test_segment_keeps_the_document_text_and_speaks_the_normalized_text():
    found = segments("Hann á 3 bækur og 17 penna. Hún kom 17. júní 1944.", 200, icelandic, min_chars=0)
    assert [s.text for s in found] == ["Hann á 3 bækur og 17 penna.", "Hún kom 17. júní 1944."]
    assert found[0].spoken == icelandic("Hann á 3 bækur og 17 penna.")
    assert found[1].spoken == "Hún kom sautjánda júní nítján hundruð fjörutíu og fjögur."


def test_an_abbreviation_does_not_end_a_sentence():
    text = "Fundurinn hefst kl. 5 í dag. Hann stendur til kl. 7."
    assert [s.spoken for s in segments(text, 200, icelandic, min_chars=0)] == [
        "Fundurinn hefst klukkan fimm í dag.", "Hann stendur til klukkan sjö."]
    text = "She met Dr. Smith and Mr. Jones at noon. They talked about No. 5 for an hour."
    assert [s.text for s in segments(text, 200, english, min_chars=0)] == [
        "She met Dr. Smith and Mr. Jones at noon.", "They talked about No. 5 for an hour."]


def test_initials_do_not_end_a_sentence():
    text = "The book by J. K. Rowling sold well in the U.S. Army camps. It was a surprise."
    assert [s.text for s in segments(text, 200, same, min_chars=0)] == [
        "The book by J. K. Rowling sold well in the U.S. Army camps.", "It was a surprise."]


def test_a_short_sentence_joins_the_next_one():
    text = "Yes. That is the answer she gave him. No."
    assert [s.text for s in segments(text, 100, same, min_chars=10)] == ["Yes. That is the answer she gave him. No."]
    assert [s.text for s in segments("No. Never.\n\nNext paragraph.", 100, same, min_chars=10)] == [
        "No. Never.", "Next paragraph."]


def test_long_sentence_splits_at_clauses_then_words():
    sentence = "This clause is long, " * 10 + "and it ends here."
    found = segments(sentence, 50, same)
    assert all(len(s.spoken) <= 50 for s in found)
    assert " ".join(s.text for s in found).split() == sentence.split()


def test_the_limit_counts_the_spoken_text():
    found = segments("He paid 1,234,567 and 7,654,321 and 1,111,111 for it.", 120, english)
    assert len(found) > 1 and all(len(s.spoken) <= 120 for s in found)
    assert " ".join(s.text for s in found) == "He paid 1,234,567 and 7,654,321 and 1,111,111 for it."


def test_a_closing_quote_stays_with_its_sentence():
    text = 'She said, "Come here!" (He did not.) "Why not?" Nobody knew.'
    assert [s.text for s in segments(text, 100, same, min_chars=0)] == [
        'She said, "Come here!"', "(He did not.)", '"Why not?"', "Nobody knew."]


def test_icelandic_capitals_start_sentences():
    assert [s.text for s in segments("Hann fór heim. Þá kom hún.", 100, same, min_chars=0)] == [
        "Hann fór heim.", "Þá kom hún."]


def test_paragraphs_with_nothing_to_say_are_skipped():
    assert [s.text for s in segments("* * *\n\nText.\n\n[1]", 100, english)] == ["Text."]
